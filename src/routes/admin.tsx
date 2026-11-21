// 관리자 화면. 관리자 세션은 이메일 인증코드 + TOTP 를 모두 통과해야만 생긴다 (src/lib/admin2fa.ts).
// 관리자에게 없는 기능: 공고 내용 수정, 이력서 전달, 추천 발송 (CLAUDE.md 규칙 1). 기업 정보도 고치지 않는다 (승인·반려만).
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import { loadActor } from '../lib/actor';
import { requireRole } from '../lib/auth';
import { identitySnapshot, parseVerifyAction } from '../lib/company';
import { serveVerificationDoc } from '../lib/files';
import { verifyBlocks } from '../lib/rules';
import { render, renderError } from '../render';
import { AdminCompanyDetail, AdminCompanyList, type AdminCompanyListRow } from '../views/admin-company';
import type { DocView, MemberView } from '../views/company';
import { AdminHome } from '../views/pages';
import { COMPANY_COLS, type CompanyRow } from './biz-ctx';

export const admin = new Hono<AppEnv>();

// /admin 아래 모든 경로는 관리자만.
admin.use('*', requireRole('admin'));

// 첫 화면: 처리할 일의 개수. 개수만 읽고 개인정보는 읽지 않는다.
admin.get('/', async (c) => {
  const db = c.env.DB;
  const [co, ag, jr, rp] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM companies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM agencies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE review_flag IS NOT NULL AND review_cleared_by IS NULL AND status IN ('draft','published')"),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results[0]?.n ?? 0;
  const counts = { companies: n(co), agencies: n(ag), jobReviews: n(jr), reports: n(rp) };
  return render(c, <AdminHome locale={c.var.locale} counts={counts} />, 'admin.title');
});

// ── 기업 검증

admin.get('/companies', async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT c.id, c.name_ko, c.entity_type, c.verify_status, c.created_at,
            (SELECT COUNT(*) FROM verification_docs d WHERE d.owner_type = 'company' AND d.owner_id = c.id) AS docs
     FROM companies c
     ORDER BY CASE c.verify_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, c.created_at DESC
     LIMIT 500`,
  ).all<AdminCompanyListRow>();
  return render(c, <AdminCompanyList locale={c.var.locale} rows={r.results} />, 'adm.co.title');
});

interface CompanyDetail { company: CompanyRow; members: MemberView[]; docs: DocView[] }

async function loadCompanyDetail(db: D1Database, id: string): Promise<CompanyDetail | null> {
  const [co, m, d] = await db.batch([
    db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE id = ?`).bind(id),
    db.prepare(
      `SELECT m.user_id, u.email, m.member_role, m.is_hq, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.member_role = 'owner' DESC, m.created_at`,
    ).bind(id),
    db.prepare("SELECT id, doc_type, review_status, created_at FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? ORDER BY created_at DESC")
      .bind(id),
  ]);
  const company = co?.results[0] as CompanyRow | undefined;
  if (!company) return null;
  return { company, members: (m?.results ?? []) as MemberView[], docs: (d?.results ?? []) as DocView[] };
}

/** 승인 조건은 rules.verifyBlocks 만 쓴다. 반려된 서류는 넣지 않는다. */
const blocksOf = (x: CompanyDetail) =>
  verifyBlocks({
    entity_type: x.company.entity_type,
    biz_no: x.company.biz_no,
    docTypes: x.docs.filter((d) => d.review_status !== 'rejected').map((d) => d.doc_type),
  });

const ADMIN_OK: Record<string, string> = { approved: 'adm.ok.approved', rejected: 'adm.ok.rejected' };

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
  const db = c.env.DB;
  const id = c.req.param('id');
  const x = await loadCompanyDetail(db, id);
  if (!x) return renderError(c, 404);
  const f = await c.req.parseBody();
  const act = parseVerifyAction(f);
  if (!act.ok) return detailPage(c, x, { error: `adm.err.${act.why}` }, 400);
  if (x.company.verify_status !== 'pending') return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
  const me = c.var.user!;
  const ts = now();

  if (act.action === 'reject') {
    const r = await db.prepare("UPDATE companies SET verify_status = 'rejected', reject_reason = ? WHERE id = ? AND verify_status = 'pending'")
      .bind(act.reason, id).run();
    if (r.meta.changes !== 1) return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
    return c.redirect(`/admin/companies/${id}?ok=rejected`);
  }

  // 승인: verifyBlocks 가 비어 있을 때만. 화면을 연 뒤 신원 항목이 바뀌었으면 다시 확인하게 한다.
  if (blocksOf(x).length) return detailPage(c, x, { error: 'adm.err.blocked' }, 400);
  if (f.seen !== identitySnapshot(x.company)) return detailPage(c, x, { error: 'adm.err.changed' }, 400);
  const res = await db.batch([
    db.prepare(
      "UPDATE companies SET verify_status = 'verified', verified_at = ?, reject_reason = NULL WHERE id = ? AND verify_status = 'pending'",
    ).bind(ts, id),
    db.prepare(
      `UPDATE verification_docs SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?
       WHERE owner_type = 'company' AND owner_id = ? AND review_status = 'pending'
         AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND verify_status = 'verified' AND verified_at = ?)`,
    ).bind(me.id, ts, id, id, ts),
  ]);
  if (res[0]?.meta.changes !== 1) return detailPage(c, x, { error: 'adm.err.not_pending' }, 400);
  return c.redirect(`/admin/companies/${id}?ok=approved`);
});

// 검증 서류 내려받기: 권한 확인·열람 기록·전송은 serveVerificationDoc 이 한다.
admin.get('/docs/:id', async (c) => {
  const actor = await loadActor(c.env, c.var.user!);
  const r = await serveVerificationDoc(c.env, actor, c.req.param('id'));
  return r ?? renderError(c, 404);
});
