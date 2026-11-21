// 관리자 화면. 관리자 세션은 이메일 인증코드 + TOTP 를 모두 통과해야만 생긴다 (src/lib/admin2fa.ts).
// 관리자에게 없는 기능: 공고 내용 수정, 이력서 전달, 추천 발송 (CLAUDE.md 규칙 1). 기업 정보도 고치지 않는다 (승인·반려·승인 취소만).
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import { loadActor } from '../lib/actor';
import { requireRole } from '../lib/auth';
import { identitySnapshot, parseRevokeAction, parseVerifyAction } from '../lib/company';
import { serveVerificationDoc } from '../lib/files';
import { verifyBlocks } from '../lib/rules';
import { todayUsage } from '../lib/quota';
import { configChecks, secretSummary, worstLevel } from '../lib/config-check';
import { SCHEDULE } from '../lib/maintenance';
import { loadRetention } from '../lib/retention-setting';
import { SystemPage } from '../views/admin-system';
import { render, renderError } from '../render';
import { AdminCompanyDetail, AdminCompanyList } from '../views/admin-company';
import { AdminHome } from '../views/pages';
import { adminApplicants } from './admin-applicants';
import { adminJobs } from './admin-jobs';
import { humanGetOnly, noStore } from './guards';
import { adminOptions } from './admin-options';
import { adminSettings } from './admin-settings';
import { adminCounts } from '../db/admin';
import {
  approveCompany, listCompaniesForAdmin, loadCompanyDetail, rejectCompany, revokeCompany, type CompanyDetail,
} from '../db/companies';

export const admin = new Hono<AppEnv>();

// 지원서 열람·열람 기록(T-09a): 권한 검사보다 먼저 no-store·HEAD/미리 가져오기 거절 (로그인 리다이렉트·403 에도 붙게).
admin.use('/applications/*', noStore, humanGetOnly);
admin.use('/access-log', noStore, humanGetOnly);
// 시스템 점검(T-13): 로그인 리다이렉트·403 에도 no-store.
admin.use('/system', noStore);

// /admin 아래 모든 경로는 관리자만.
admin.use('*', requireRole('admin'));

// 첫 화면: 처리할 일의 개수 + 오늘 사용량(T-05c, 사이트 전체 번역 호출·기업 메일 — 읽기 두 번). 개수만 읽고 개인정보는 읽지 않는다.
admin.get('/', async (c) => {
  const [counts, usage] = await Promise.all([adminCounts(c.env.DB), todayUsage(c.env, now())]);
  return render(c, <AdminHome locale={c.var.locale} counts={counts} usage={usage} />, 'admin.title');
});

// ── 시스템 점검 (T-13): 설정 점검 결과·비밀값 유무(값은 보이지 않음)·예약 작업 시간표·오늘 사용량·보관 기간(읽기만).
// 요청을 막지 않고 보여 주기만 한다. 읽기: 사용량 두 번 + 보관 기간 설정 한 번. 공개 주소(/api/health)에는 점검 결과를 내지 않는다.
admin.get('/system', async (c) => {
  const checks = configChecks(c.env);
  const [usage, retention] = await Promise.all([todayUsage(c.env, now()), loadRetention(c.env.DB)]);
  return render(c, (
    <SystemPage locale={c.var.locale} appEnv={c.env.APP_ENV} worst={worstLevel(checks)} checks={checks}
      secrets={secretSummary(c.env)} schedule={SCHEDULE} usage={usage} retention={retention} />
  ), 'sys.title');
});

// ── 기업 검증

admin.get('/companies', async (c) => {
  const rows = await listCompaniesForAdmin(c.env.DB);
  return render(c, <AdminCompanyList locale={c.var.locale} rows={rows} />, 'adm.co.title');
});

/** 승인 조건은 rules.verifyBlocks 만 쓴다. 반려된 서류는 넣지 않는다. */
const blocksOf = (x: CompanyDetail) =>
  verifyBlocks({
    entity_type: x.company.entity_type,
    biz_no: x.company.biz_no,
    docTypes: x.docs.filter((d) => d.review_status !== 'rejected').map((d) => d.doc_type),
  });

const ADMIN_OK: Record<string, string> = { approved: 'adm.ok.approved', rejected: 'adm.ok.rejected', revoked: 'adm.ok.revoked' };

function detailPage(c: Context<AppEnv>, x: CompanyDetail, msg: { ok?: string; error?: string }, status: 200 | 400 = 200) {
  return render(
    c,
    <AdminCompanyDetail
      locale={c.var.locale} company={x.company} members={x.members} docs={x.docs}
      blocks={blocksOf(x)} snapshot={identitySnapshot(x.company)} ok={msg.ok} error={msg.error}
    />,
    'adm.co.title',
    status,
  );
}

admin.get('/companies/:id', async (c) => {
  const x = await loadCompanyDetail(c.env.DB, c.req.param('id'));
  if (!x) return renderError(c, 404);
  return detailPage(c, x, { ok: ADMIN_OK[c.req.query('ok') ?? ''] });
});

admin.post('/companies/:id/verify', async (c) => {
  const id = c.req.param('id');
  const x = await loadCompanyDetail(c.env.DB, id);
  if (!x) return renderError(c, 404);
  const f = await c.req.parseBody();
  const act = parseVerifyAction(f);
  if (!act.ok) return detailPage(c, x, { error: `adm.err.${act.why}` }, 400);
  if (x.company.verify_status !== 'pending') return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
  const me = c.var.user!;
  const ts = now();

  if (act.action === 'reject') {
    // 서류 반려(선택)를 먼저, 기업 반려를 마지막에 둔다 (src/db/companies.ts rejectCompany). 마지막 문장의 결과로 판단한다.
    const rejected = await rejectCompany(c.env.DB, { id, reason: act.reason, rejectDocs: act.rejectDocs, adminId: me.id, ts });
    if (!rejected) return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
    return c.redirect(`/admin/companies/${id}?ok=rejected`);
  }

  // 승인: verifyBlocks 가 비어 있을 때만. 화면을 연 뒤 신원 항목이 바뀌었으면 다시 확인하게 한다.
  if (blocksOf(x).length) return detailPage(c, x, { error: 'adm.err.blocked' }, 400);
  if (f.seen !== identitySnapshot(x.company)) return detailPage(c, x, { error: 'adm.err.changed' }, 400);
  const approved = await approveCompany(c.env.DB, { id, adminId: me.id, ts });
  if (!approved) return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
  return c.redirect(`/admin/companies/${id}?ok=approved`);
});

// 승인 취소: 검증 완료된 기업만, 사유 필수. 기업은 반려 상태가 되어 공개 목록에서 빠지고, 게재 중인 공고는 모두 마감한다.
// 기업은 기존 흐름(신원 항목 수정·서류 올리기)으로 다시 검증 대기가 된다. 기업 정보 자체는 고치지 않는다.
admin.post('/companies/:id/revoke', async (c) => {
  const id = c.req.param('id');
  const x = await loadCompanyDetail(c.env.DB, id);
  if (!x) return renderError(c, 404);
  const act = parseRevokeAction(await c.req.parseBody());
  if (!act.ok) return detailPage(c, x, { error: `adm.err.revoke_${act.why}` }, 400);
  if (x.company.verify_status !== 'verified') return detailPage(c, x, { error: 'adm.err.not_verified' }, 400);
  const me = c.var.user!;
  const ts = now();
  // 공고 마감·서류 반려를 먼저, 기업 상태 변경을 마지막에 둔다 (src/db/companies.ts revokeCompany). 마지막 문장의 결과로 판단한다.
  const revoked = await revokeCompany(c.env.DB, { id, reason: act.reason, rejectDocs: act.rejectDocs, adminId: me.id, ts });
  if (!revoked) return detailPage(c, x, { error: 'adm.err.not_verified' }, 400);
  return c.redirect(`/admin/companies/${id}?ok=revoked`);
});

// 검증 서류 내려받기: 권한 확인·열람 기록·전송은 serveVerificationDoc 이 한다.
admin.get('/docs/:id', async (c) => {
  const actor = await loadActor(c.env, c.var.user!);
  const r = await serveVerificationDoc(c.env, actor, c.req.param('id'));
  return r ?? renderError(c, 404);
});

// 공고 검토·차단·현지화 엔진 비교 (/admin/jobs, /admin/localize-test)
admin.route('/', adminJobs);

// 사이트 설정: 채용정보 목록에 보일 검색 조건 (/admin/settings)
admin.route('/', adminSettings);

// 직무·업계·근무지 선택 항목 관리 (/admin/options). 추가·이름·순서·사용 종료만, 삭제 없음
admin.route('/', adminOptions);

// 지원서 사유 입력 열람·열람 기록 (/admin/applications/:id, /admin/access-log). 지원자 목록·사람 검색은 없다
admin.route('/', adminApplicants);
