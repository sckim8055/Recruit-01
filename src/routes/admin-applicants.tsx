// 관리자의 지원서 열람·열람 기록 (T-09a): /admin/access-log, /admin/applications/:id (정보 + 사유 폼),
// POST /admin/applications/:id/open (사유 → 내용), POST /admin/applications/:id/file (사유 → 첨부).
//
// 원칙 (CLAUDE.md 규칙 1·4, docs/ARCHITECTURE.md 12장)
// - GET 화면에는 개인정보가 없다 (getApplicationWithJob 의 공고·기업 id·날짜·상태·동의/첨부 여부만). GET 은 기록을 남기지 않는다.
// - 내용은 사유를 낸 POST 의 응답에만 그린다 (리다이렉트 없음, 다시 GET 할 수 있는 주소에 내용 없음). openApplication 이 사유·기록을 확인한다.
// - 관리자 열람은 상태를 바꾸지 않는다 (openApplication). 수정·전달·일괄 내려받기·지원자 목록·사람 검색은 없다.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { loadActor } from '../lib/actor';
import { ADMIN_REASON_MAX, cleanReason, downloadApplicationFile, openApplication } from '../lib/applicants';
import { render, renderError } from '../render';
import {
  ACCESS_LOG_TYPES, AccessLogPage, AdminApplicationContent, AdminApplicationPage, type AccessLogType,
} from '../views/applicants';
import { getApplicationWithJob, listAccessLog, type ApplicationWithJob } from '../db/applicants';

export const adminApplicants = new Hono<AppEnv>();

export const ACCESS_LOG_PAGE = 50;

const loadApp = (c: Context<AppEnv>): Promise<ApplicationWithJob | null> => getApplicationWithJob(c.env.DB, c.req.param('id') ?? '');

const readReason = async (c: Context<AppEnv>): Promise<string> => {
  const f = await c.req.parseBody();
  return typeof f.reason === 'string' ? f.reason : '';
};

// ── 열람 기록

adminApplicants.get('/access-log', async (c) => {
  const rawType = c.req.query('type') ?? '';
  const type = (ACCESS_LOG_TYPES as readonly string[]).includes(rawType) ? (rawType as AccessLogType) : null;
  const rawBefore = c.req.query('before') ?? '';
  const before = /^\d{1,12}$/.test(rawBefore) ? Number(rawBefore) : null;
  // 한 줄 더 읽어 다음 페이지가 있는지 안다.
  const got = await listAccessLog(c.env.DB, { limit: ACCESS_LOG_PAGE + 1, before, targetType: type });
  let rows = got.slice(0, ACCESS_LOG_PAGE);
  let next: number | null = null;
  if (got.length > ACCESS_LOG_PAGE) {
    // 커서는 시각(at < before)뿐이다. 다음 줄(51번째)이 이 페이지 마지막 줄과 같은 초이면 그 초의 나머지 줄이 다음 페이지에서 빠지므로,
    // 그 초의 줄을 이 페이지에서 빼고 다음 페이지(at <= 그 초)에서 모두 보인다. 한 초에 50줄이 넘으면 그대로 두고 그 초 다음부터 이어진다(알려진 한계).
    const lastAt = rows[rows.length - 1]!.at;
    const trimmed = got[ACCESS_LOG_PAGE]!.at === lastAt ? rows.filter((r) => r.at > lastAt) : rows;
    if (trimmed.length === rows.length) next = lastAt;
    else if (trimmed.length > 0) {
      rows = trimmed;
      next = lastAt + 1;
    } else next = lastAt;
  }
  return render(c, <AccessLogPage locale={c.var.locale} rows={rows} type={type} next={next} first={before === null} />, 'adm.log.title');
});

// ── 지원서: 정보 + 사유 폼 (기록 없음)

adminApplicants.get('/applications/:id', async (c) => {
  const app = await loadApp(c);
  if (!app) return renderError(c, 404);
  return render(c, <AdminApplicationPage locale={c.var.locale} app={app} />, 'adm.app.title');
});

adminApplicants.post('/applications/:id/open', async (c) => {
  const app = await loadApp(c);
  if (!app) return renderError(c, 404);
  const reason = await readReason(c);
  const actor = await loadActor(c.env, c.var.user!);
  const r = await openApplication(c.env, actor, app, reason);
  const l = c.var.locale;
  if (r.ok) {
    return render(c, <AdminApplicationContent locale={l} app={app} body={r.body} reason={cleanReason(reason) ?? ''} />, 'adm.app.title');
  }
  switch (r.why) {
    case 'reason_required':
      return render(c, <AdminApplicationPage locale={l} app={app} reason={reason.slice(0, ADMIN_REASON_MAX)} error="adm.app.err.reason" />, 'adm.app.title', 400);
    case 'withdrawn':
    case 'unreadable':
      return render(c, <AdminApplicationPage locale={l} app={app} notice={r.why} />, 'adm.app.title');
    default:
      return renderError(c, 404);
  }
});

// ── 첨부파일: 사유와 함께 POST → downloadApplicationFile (권한·사유·기록)

adminApplicants.post('/applications/:id/file', async (c) => {
  const app = await loadApp(c);
  if (!app) return renderError(c, 404);
  const reason = await readReason(c);
  const actor = await loadActor(c.env, c.var.user!);
  const res = await downloadApplicationFile(c.env, actor, app, reason);
  if (res) return res;
  return render(c, <AdminApplicationPage locale={c.var.locale} app={app} error="adm.app.err.file" />, 'adm.app.title', 400);
});
