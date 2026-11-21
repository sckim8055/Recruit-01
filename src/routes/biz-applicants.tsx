// 기업의 지원자 화면 (T-09a): /biz/jobs/:id/applicants (목록), /biz/applications/:id (지원서), /biz/applications/:id/file (첨부).
//
// 원칙 (CLAUDE.md 규칙 1·3·4·5, docs/ARCHITECTURE.md 12장)
// - 기업 id 는 로그인 사용자의 소속(biz-ctx.ts)에서만 정한다. 남의 공고·남의 지원서는 있는지도 알리지 않고 404.
// - 목록(listJobApplications)에는 내용이 없다. 지원서 내용은 lib/applicants.openApplication 만 연다 (권한 → 복호화 → access_log → 'viewed').
//   이 파일은 resume_snapshot 을 풀지 않고, 상태를 바꾸지 않고, application_events 에 쓰지 않는다.
// - 첨부는 lib/applicants.downloadApplicationFile 만 쓴다 (openApplication 을 부르지 않는다 — 기록이 두 번 남지 않게).
// - 지원서 화면은 요청 한 번에 openApplication 한 번. 캐시·미리 읽기 없음. HEAD·브라우저 미리 가져오기는 기록 전에 거절한다 (guards.humanGetOnly, biz.tsx 에서 붙임).
// - 정렬·추천·메모·내보내기·전달·상태 변경 버튼은 만들지 않는다.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { downloadApplicationFile, openApplication, refOf } from '../lib/applicants';
import { canEditJob } from '../lib/authz';
import { render, renderError } from '../render';
import { ApplicantList, CompanyApplicationNotice, CompanyApplicationPage } from '../views/applicants';
import { requireCompany } from './biz-company';
import { getApplicationWithJob, listJobApplications, type ApplicationWithJob } from '../db/applicants';
import { loadJob } from '../db/jobs';
import type { CompanyCtx } from './biz-ctx';

export const bizApplicants = new Hono<AppEnv>();

// ── 지원자 목록

bizApplicants.get('/jobs/:id/applicants', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job || !canEditJob(ctx.actor, job)) return renderError(c, 404);
  const rows = await listJobApplications(c.env.DB, job.id);
  return render(c, (
    <ApplicantList locale={c.var.locale} job={job} rows={rows} hq={ctx.actor.hqCompanyIds.includes(job.company_id)} />
  ), 'apl.list.title');
});

/** 이 기업 공고의 지원서만 (공고 수정 권한과 같은 조건). 없거나 남의 것이면 null → 404. */
async function loadCompanyApp(c: Context<AppEnv>, ctx: CompanyCtx): Promise<ApplicationWithJob | null> {
  const app = await getApplicationWithJob(c.env.DB, c.req.param('id') ?? '');
  if (!app || !canEditJob(ctx.actor, refOf(app).job)) return null;
  return app;
}

// ── 지원서 한 건: openApplication 한 번 (처음 열면 'viewed', 열 때마다 access_log)

bizApplicants.get('/applications/:id', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const app = await loadCompanyApp(c, ctx);
  if (!app) return renderError(c, 404);
  const r = await openApplication(c.env, ctx.actor, app, null);
  const l = c.var.locale;
  if (r.ok) return render(c, <CompanyApplicationPage locale={l} app={app} status={r.status} body={r.body} />, 'apl.page.title');
  switch (r.why) {
    case 'withdrawn': return render(c, <CompanyApplicationNotice locale={l} jobId={app.job_id} kind="withdrawn" />, 'apl.page.title');
    case 'no_cross_border_consent': return render(c, <CompanyApplicationNotice locale={l} jobId={app.job_id} kind="no_consent" />, 'apl.page.title', 403);
    case 'unreadable': return render(c, <CompanyApplicationNotice locale={l} jobId={app.job_id} kind="unreadable" />, 'apl.page.title');
    default: return renderError(c, 404); // forbidden · reason_required (기업에는 해당 없음)
  }
});

// ── 첨부파일: 권한 확인 → 기록 → 복호화 → attachment 는 downloadApplicationFile 이 한다

bizApplicants.get('/applications/:id/file', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const app = await loadCompanyApp(c, ctx);
  if (!app) return renderError(c, 404);
  const res = await downloadApplicationFile(c.env, ctx.actor, app, null);
  return res ?? renderError(c, 404);
});
