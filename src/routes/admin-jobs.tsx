// 관리자 공고 화면. 관리자는 공고 내용을 고칠 수 없고 게재도 할 수 없다 (CLAUDE.md 규칙 1: 운영자는 공고를 쓰거나 올리지 않는다).
// 할 수 있는 일: 기술유출 검토 통과(review_cleared_by), 차단(사유 필수), 차단 해제(→ 초안). 그리고 현지화 엔진 비교(저장하지 않음).
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { loadActor } from '../lib/actor';
import { canBlockJob } from '../lib/authz';
import { JOB_LIMITS, hasContactInText, readBlockReason, readRev } from '../lib/jobs';
import { availableEngines, runEngine } from '../lib/localize';
import { ENGINES } from '../lib/localize/registry';
import type { EngineRun } from '../lib/localize/types';
import { render, renderError } from '../render';
import { AdminJobDetail, AdminJobList, LocalizeTestPage } from '../views/admin-jobs';
import { findCompanyBrief } from '../db/companies';
import { blockJob, clearJobReview, listJobsForAdmin, loadJob, unblockJob, type JobRow } from '../db/jobs';

export const adminJobs = new Hono<AppEnv>();

/** /admin 아래는 requireRole('admin') 을 이미 통과했다. 차단 권한은 authz 로 한 번 더 확인한다. */
async function requireBlocker(c: Context<AppEnv>): Promise<Response | null> {
  const actor = await loadActor(c.env, c.var.user!);
  return canBlockJob(actor) ? null : renderError(c, 403);
}

adminJobs.get('/jobs', async (c) => {
  const rows = await listJobsForAdmin(c.env.DB);
  return render(c, <AdminJobList locale={c.var.locale} rows={rows} />, 'adm.job.title');
});

const OK: Record<string, string> = { cleared: 'adm.job.ok.cleared', blocked: 'adm.job.ok.blocked', unblocked: 'adm.job.ok.unblocked' };

async function detailPage(c: Context<AppEnv>, job: JobRow, msg: { ok?: string; error?: string }, status: 200 | 400 = 200) {
  const co = await findCompanyBrief(c.env.DB, job.company_id);
  return render(c, <AdminJobDetail locale={c.var.locale} job={job} company={co} ok={msg.ok} error={msg.error} />, 'adm.job.title', status);
}

adminJobs.get('/jobs/:id', async (c) => {
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) return renderError(c, 404);
  return detailPage(c, job, { ok: OK[c.req.query('ok') ?? ''] });
});

// 검토 통과: 화면에서 본 내용 버전(rev)이 그대로일 때만. 그 뒤 기업이 글을 바꾸면 다시 검토 대기가 된다 (jobs.reviewAfterSave).
adminJobs.post('/jobs/:id/clear-review', async (c) => {
  const deny = await requireBlocker(c);
  if (deny) return deny;
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) return renderError(c, 404);
  const f = await c.req.parseBody();
  if (!job.review_flag || job.review_cleared_by) return detailPage(c, job, { error: 'adm.job.err.not_flagged' }, 400);
  if (readRev(f) !== job.rev) return detailPage(c, job, { error: 'adm.job.err.changed' }, 400);
  const cleared = await clearJobReview(c.env.DB, { adminId: c.var.user!.id, id: job.id, rev: job.rev });
  if (!cleared) return detailPage(c, job, { error: 'adm.job.err.changed' }, 400);
  return c.redirect(`/admin/jobs/${job.id}?ok=cleared`);
});

// 차단: 사유 필수. 게재 중이면 바로 내려간다. 기업은 차단 사유를 보고 내용을 고칠 수 있지만, 해제는 관리자만 한다.
adminJobs.post('/jobs/:id/block', async (c) => {
  const deny = await requireBlocker(c);
  if (deny) return deny;
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) return renderError(c, 404);
  const r = readBlockReason(await c.req.parseBody());
  if (!r.ok) return detailPage(c, job, { error: `adm.job.err.${r.why}` }, 400);
  const blocked = await blockJob(c.env.DB, { reason: r.reason, id: job.id });
  if (!blocked) return detailPage(c, job, { error: 'adm.job.err.already_blocked' }, 400);
  return c.redirect(`/admin/jobs/${job.id}?ok=blocked`);
});

// 차단 해제: 초안으로 되돌린다. 게재는 기업이 다시 해야 한다 (publishBlocks 를 다시 거친다).
adminJobs.post('/jobs/:id/unblock', async (c) => {
  const deny = await requireBlocker(c);
  if (deny) return deny;
  const job = await loadJob(c.env.DB, c.req.param('id'));
  if (!job) return renderError(c, 404);
  const unblocked = await unblockJob(c.env.DB, job.id);
  if (!unblocked) return detailPage(c, job, { error: 'adm.job.err.not_blocked' }, 400);
  return c.redirect(`/admin/jobs/${job.id}?ok=unblocked`);
});

// ── 현지화 엔진 비교: 같은 글을 여러 엔진에 넣어 결과·시간을 나란히 본다. 아무것도 저장하지 않는다.

export interface CompareResult { id: string; run: EngineRun }

adminJobs.get('/localize-test', (c) => {
  const avail = availableEngines(c.env).map((e) => e.id);
  return render(c, <LocalizeTestPage locale={c.var.locale} all={ENGINES.map((e) => e.id)} available={avail} input={{ title: '', body: '' }} selected={avail} results={[]} />, 'adm.lt.title');
});

adminJobs.post('/localize-test', async (c) => {
  const f = await c.req.parseBody({ all: true });
  const one = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
  const input = { title: one(f.title).trim().replace(/\s*\n\s*/g, ' '), body: one(f.body).replace(/\r\n?/g, '\n').trim() };
  const picked = (Array.isArray(f.engines) ? f.engines : [f.engines]).filter((v): v is string => typeof v === 'string');
  const avail = availableEngines(c.env);
  const selected = avail.filter((e) => picked.includes(e.id));
  const page = (results: CompareResult[], error?: string, status: 200 | 400 = 200) =>
    render(c, <LocalizeTestPage locale={c.var.locale} all={ENGINES.map((e) => e.id)} available={avail.map((e) => e.id)} input={input}
      selected={selected.map((e) => e.id)} results={results} error={error} />, 'adm.lt.title', status);
  if (!input.title || !input.body) return page([], 'adm.lt.err.required', 400);
  if (input.title.length > JOB_LIMITS.title || input.body.length > JOB_LIMITS.body) return page([], 'adm.lt.err.too_long', 400);
  if (hasContactInText(`${input.title}\n${input.body}`)) return page([], 'adm.lt.err.contact', 400);
  if (!selected.length) return page([], avail.length ? 'adm.lt.err.pick' : 'adm.lt.none', 400);
  // 엔진별로 한 번씩, 동시에 부른다.
  const runs = await Promise.all(selected.map((e) => runEngine(e, c.env, { titleZh: input.title, bodyZh: input.body })));
  return page(selected.map((e, i) => ({ id: e.id, run: runs[i]! })));
});
