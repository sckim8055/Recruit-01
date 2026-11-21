// 기업 공고 화면 (/biz/jobs...). 기업 담당자가 중국어로 쓰고 → 한국어 초안(현지화 엔진 또는 직접 입력) → 대조본 확인 → 승인 → 게재.
// - 기업 id 는 로그인 사용자의 소속(biz-ctx.ts)에서만 정한다. 남의 공고는 canEditJob 이 거부하고 404 로 답한다
// - 게재는 rules.publishBlocks 가 빈 배열일 때만 (CLAUDE.md 규칙 2). UPDATE 의 WHERE 는 그사이 바뀔 수 있는 사실만 다시 확인한다
// - 모든 쓰기는 읽은 내용 버전(rev)·상태가 그대로일 때만 반영한다 (다른 탭·다른 담당자와 겹쳐도 덮어쓰지 않게)
// - 헤드헌터 공고(agency_id)는 여기서 만들지 않는다 (T-15)
import { Hono, type Context } from 'hono';
import { flagsOf, now, type AppEnv } from '../env';
import { canEditJob } from '../lib/authz';
import {
  EMPTY_JOB_INPUT, digitDiff, inputFromJob, planJobSave, publishInputOf, readJobForm, readKoreanForm, readRev, reviewAfterSave,
  validateJob, type JobFieldError, type JobInput, type JobText,
} from '../lib/jobs';
import { availableEngines, localizeJob } from '../lib/localize';
import { buildOptionSet, selectableAll, type OptionKind, type OptionSet } from '../lib/options';
import { parseOperatorDomains, publishBlocks } from '../lib/rules';
import { render, renderError } from '../render';
import { JobFormPage, JobList, JobReview } from '../views/jobs';
import type { CompanyCtx } from './biz-ctx';
import { requireCompany } from './biz-company';
import {
  approveJob, claimLocalize, closeJob, insertJob, jobFieldsOf, listCompanyJobs, loadJob, publishJob, saveKorean, saveLocalized,
  updateJobSource, type JobRow,
} from '../db/jobs';
import { listOptions } from '../db/options';

export const bizJobs = new Hono<AppEnv>();

/** 같은 공고에서 현지화 엔진을 다시 부를 수 있는 최소 간격(초). 비용 보호. */
export const LOCALIZE_GAP = 20;

const publishCtx = (c: Context<AppEnv>, ctx: CompanyCtx) => ({
  companyVerified: ctx.company.verify_status === 'verified',
  flags: flagsOf(c.env),
  appEnv: c.env.APP_ENV,
  registrationNo: c.env.REGISTRATION_NO ?? '',
  operatorDomains: parseOperatorDomains(c.env.OPERATOR_DOMAINS ?? ''),
});

/** 소속 기업 담당자이고, 이 공고를 고칠 수 있을 때만 통과. 없는 공고·남의 공고는 구분하지 않고 404. */
async function requireJob(c: Context<AppEnv>): Promise<{ ctx: CompanyCtx; job: JobRow } | Response> {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const job = await loadJob(c.env.DB, c.req.param('id') ?? '');
  if (!job || !canEditJob(ctx.actor, job)) return renderError(c, 404);
  return { ctx, job };
}

const OK: Record<string, string> = {
  created: 'job.ok.created', saved: 'job.ok.saved', localized: 'job.ok.localized', korean: 'job.ok.korean',
  approved: 'job.ok.approved', published: 'job.ok.published', closed: 'job.ok.closed', unpublished: 'job.ok.unpublished',
};

/** 직무·업계·근무지 항목 (job_options 전체, 한 번 읽기). */
const loadOptions = async (c: Context<AppEnv>): Promise<OptionSet> => buildOptionSet(await listOptions(c.env.DB));

async function reviewPage(
  c: Context<AppEnv>, ctx: CompanyCtx, job: JobRow,
  msg: { ok?: string; error?: string; koErrors?: JobFieldError[]; koInput?: { title_ko: string; body_ko: string }; showBlocks?: boolean },
  status: 200 | 400 = 200,
) {
  const blocks = publishBlocks(publishInputOf(job, publishCtx(c, ctx)));
  const options = await loadOptions(c);
  const digits = job.title_ko || job.body_ko
    ? digitDiff(`${job.title_zh ?? ''}\n${job.source_zh ?? ''}`, `${job.title_ko ?? ''}\n${job.body_ko ?? ''}`)
    : { missing: [], extra: [] };
  return render(
    c,
    <JobReview
      locale={c.var.locale} job={job} options={options} blocks={blocks} digits={digits}
      enginesAvailable={availableEngines(c.env).length > 0}
      ok={msg.ok} error={msg.error} koErrors={msg.koErrors ?? []} koInput={msg.koInput} highlightBlocks={msg.showBlocks}
    />,
    'job.title',
    status,
  );
}

// ── 목록

bizJobs.get('/jobs', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const rows = await listCompanyJobs(c.env.DB, ctx.company.id);
  return render(c, <JobList locale={c.var.locale} rows={rows} verified={ctx.company.verify_status === 'verified'} />, 'job.list.title');
});

// ── 새 공고

// 직무·업계·근무지: 화면에 보이는 목록(selectable)과 서버 검사(validateJob)가 받는 목록은 같은 값이다 (lib/options.selectableAll).
// 새 공고는 사용 중인 항목만, 편집은 + 그 공고에 지금 저장된 값 (사용 종료여도).
interface FormOptions { options: OptionSet; selectable: Record<OptionKind, string[]> }

const formPage = (
  c: Context<AppEnv>,
  p: FormOptions & { input: JobInput; errors: JobFieldError[]; action: string; jobId?: string; rev?: number; error?: string },
  status: 200 | 400 = 200,
) => render(c, <JobFormPage locale={c.var.locale} productionJobs={flagsOf(c.env).productionJobs} {...p} />, 'job.form.title', status);

const validateCtx = (c: Context<AppEnv>, selectable: Record<OptionKind, string[]>) => ({
  flags: flagsOf(c.env), operatorDomains: parseOperatorDomains(c.env.OPERATOR_DOMAINS ?? ''), now: now(), options: selectable,
});

async function newFormOptions(c: Context<AppEnv>): Promise<FormOptions> {
  const options = await loadOptions(c);
  return { options, selectable: selectableAll(options) };
}

async function editFormOptions(c: Context<AppEnv>, job: JobRow): Promise<FormOptions> {
  const options = await loadOptions(c);
  return { options, selectable: selectableAll(options, job) };
}

bizJobs.get('/jobs/new', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  return formPage(c, { ...(await newFormOptions(c)), input: EMPTY_JOB_INPUT, errors: [], action: '/biz/jobs/new' });
});

bizJobs.post('/jobs/new', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const input = readJobForm(await c.req.parseBody());
  const fo = await newFormOptions(c);
  const r = validateJob(input, validateCtx(c, fo.selectable));
  if (!r.ok) return formPage(c, { ...fo, input, errors: r.errors, action: '/biz/jobs/new' }, 400);
  const v = r.value;
  const empty: JobText = { title_zh: null, source_zh: null, title_ko: null, body_ko: null };
  const review = reviewAfterSave({ ...empty, review_cleared_by: null }, { ...empty, title_zh: v.title_zh, source_zh: v.source_zh });
  const id = crypto.randomUUID();
  const ts = now();
  await insertJob(c.env.DB, { id, companyId: ctx.company.id, createdBy: ctx.user.id, v, reviewFlag: review.review_flag, ts });
  return c.redirect(`/biz/jobs/${id}?ok=created`);
});

// ── 확인 화면 (원문 | 한국어 초안 | 대조본)

bizJobs.get('/jobs/:id', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  return reviewPage(c, x.ctx, x.job, { ok: OK[c.req.query('ok') ?? ''] });
});

// ── 원문·조건 편집

bizJobs.get('/jobs/:id/edit', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  if (x.job.status === 'closed') return reviewPage(c, x.ctx, x.job, { error: 'job.err.closed' }, 400);
  return formPage(c, {
    ...(await editFormOptions(c, x.job)), input: inputFromJob(jobFieldsOf(x.job)), errors: [], action: `/biz/jobs/${x.job.id}/edit`, jobId: x.job.id, rev: x.job.rev,
  });
});

bizJobs.post('/jobs/:id/edit', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  const f = await c.req.parseBody();
  const input = readJobForm(f);
  const action = `/biz/jobs/${job.id}/edit`;
  if (job.status === 'closed') return reviewPage(c, ctx, job, { error: 'job.err.closed' }, 400);
  const fo = await editFormOptions(c, job);
  if (readRev(f) !== job.rev) return formPage(c, { ...fo, input, errors: [], action, jobId: job.id, rev: job.rev, error: 'job.err.stale' }, 400);
  const r = validateJob(input, validateCtx(c, fo.selectable));
  if (!r.ok) return formPage(c, { ...fo, input, errors: r.errors, action, jobId: job.id, rev: job.rev }, 400);
  const v = r.value;
  const next: JobText = { title_zh: v.title_zh, source_zh: v.source_zh, title_ko: job.title_ko, body_ko: job.body_ko };
  // 글은 그대로이고 조건만 바뀐 게재 중 공고: 바뀐 값으로도 publishBlocks 가 비어 있어야 게재를 유지한다.
  const plan = planJobSave(job, next, (review) =>
    publishBlocks(publishInputOf({ ...job, ...v, ...review }, publishCtx(c, ctx))).length === 0);
  const saved = await updateJobSource(c.env.DB, { v, plan, ts: now(), id: job.id, rev: job.rev, readStatus: job.status });
  if (!saved) return formPage(c, { ...fo, input, errors: [], action, jobId: job.id, rev: job.rev, error: 'job.err.stale' }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=${plan.unpublished ? 'unpublished' : 'saved'}`);
});

// ── 현지화 초안 만들기 · 다시 만들기

bizJobs.post('/jobs/:id/localize', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  const f = await c.req.parseBody();
  if (job.status === 'closed') return reviewPage(c, ctx, job, { error: 'job.err.closed' }, 400);
  if (readRev(f) !== job.rev) return reviewPage(c, ctx, job, { error: 'job.err.stale' }, 400);
  if (!job.title_zh || !job.source_zh) return reviewPage(c, ctx, job, { error: 'job.err.no_source' }, 400);
  if (availableEngines(c.env).length === 0) return reviewPage(c, ctx, job, { error: 'job.err.no_engine' }, 400);
  // 짧은 간격으로 반복 호출하지 못하게 먼저 시각을 기록한다 (한 문장으로 확인과 기록을 같이).
  const ts = now();
  const claimed = await claimLocalize(c.env.DB, { ts, id: job.id, rev: job.rev, notAfter: ts - LOCALIZE_GAP });
  if (!claimed) return reviewPage(c, ctx, job, { error: 'job.err.too_soon' }, 400);

  // 엔진에는 중국어 제목·본문만 보낸다. 연락처·연봉 같은 항목은 보내지 않는다.
  const again = f.again === '1';
  const out = await localizeJob(c.env, { titleZh: job.title_zh, bodyZh: job.source_zh }, { after: again ? job.localize_engine : null });
  if (!out.ok) {
    // 기업에는 엔진 이름·오류 내용을 보여주지 않는다.
    return reviewPage(c, ctx, job, { error: out.why === 'no_engine' ? 'job.err.no_engine' : 'job.err.localize_failed' }, 400);
  }
  const next: JobText = { title_zh: job.title_zh, source_zh: job.source_zh, title_ko: out.title_ko, body_ko: out.body_ko };
  const plan = planJobSave(job, next, (review) =>
    publishBlocks(publishInputOf({ ...job, ...next, ...review }, publishCtx(c, ctx))).length === 0);
  const saved = await saveLocalized(c.env.DB, {
    title_ko: out.title_ko, body_ko: out.body_ko, back_zh: out.back_zh, engine: out.engine, plan, ts: now(),
    id: job.id, rev: job.rev, readStatus: job.status,
  });
  // 엔진을 부르는 동안 다른 담당자가 원문을 고쳤으면 이 결과는 버린다 (옛 원문으로 만든 초안이므로).
  if (!saved) return reviewPage(c, ctx, (await loadJob(c.env.DB, job.id)) ?? job, { error: 'job.err.stale' }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=${plan.unpublished ? 'unpublished' : 'localized'}`);
});

// ── 한국어 초안 직접 입력·수정 (수동 모드). 대조본은 지운다 — 직접 고친 글의 대조본이 아니기 때문이다.

bizJobs.post('/jobs/:id/korean', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  const f = await c.req.parseBody();
  const koInput = { title_ko: typeof f.title_ko === 'string' ? f.title_ko : '', body_ko: typeof f.body_ko === 'string' ? f.body_ko : '' };
  if (job.status === 'closed') return reviewPage(c, ctx, job, { error: 'job.err.closed' }, 400);
  if (readRev(f) !== job.rev) return reviewPage(c, ctx, job, { error: 'job.err.stale', koInput }, 400);
  const k = readKoreanForm(f);
  if (!k.ok) return reviewPage(c, ctx, job, { koErrors: k.errors, koInput }, 400);
  const next: JobText = { title_zh: job.title_zh, source_zh: job.source_zh, title_ko: k.title_ko, body_ko: k.body_ko };
  const plan = planJobSave(job, next, (review) =>
    publishBlocks(publishInputOf({ ...job, ...next, ...review }, publishCtx(c, ctx))).length === 0);
  const koChanged = k.title_ko !== job.title_ko || k.body_ko !== job.body_ko;
  const saved = await saveKorean(c.env.DB, {
    title_ko: k.title_ko, body_ko: k.body_ko, back_zh: koChanged ? null : job.back_zh, plan, ts: now(),
    id: job.id, rev: job.rev, readStatus: job.status,
  });
  if (!saved) return reviewPage(c, ctx, job, { error: 'job.err.stale', koInput }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=${plan.unpublished ? 'unpublished' : 'korean'}`);
});

// ── 승인: 기업이 한국어 초안(과 대조본)을 확인했다는 표시. 화면에서 본 내용 버전(rev)이 그대로일 때만.

bizJobs.post('/jobs/:id/approve', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  const f = await c.req.parseBody();
  if (job.status === 'closed') return reviewPage(c, ctx, job, { error: 'job.err.closed' }, 400);
  if (readRev(f) !== job.rev) return reviewPage(c, ctx, job, { error: 'job.err.stale' }, 400);
  if (job.localize_status !== 'review' || !job.title_ko?.trim() || !job.body_ko?.trim()) {
    return reviewPage(c, ctx, job, { error: 'job.err.not_review' }, 400);
  }
  const approved = await approveJob(c.env.DB, { id: job.id, rev: job.rev });
  if (!approved) return reviewPage(c, ctx, job, { error: 'job.err.stale' }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=approved`);
});

// ── 게재: publishBlocks 가 빈 배열일 때만 (CLAUDE.md 규칙 2)

bizJobs.post('/jobs/:id/publish', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  const f = await c.req.parseBody();
  if (readRev(f) !== job.rev) return reviewPage(c, ctx, job, { error: 'job.err.stale' }, 400);
  if (job.status !== 'draft') return reviewPage(c, ctx, job, { error: 'job.err.not_draft' }, 400);
  const blocks = publishBlocks(publishInputOf(job, publishCtx(c, ctx)));
  if (blocks.length) return reviewPage(c, ctx, job, { error: 'job.err.blocked', showBlocks: true }, 400);
  const ts = now();
  // publishJob 의 WHERE 는 publishBlocks 가 본 사실 중 그사이 바뀔 수 있는 것만 다시 확인한다 (src/db/jobs.ts).
  const published = await publishJob(c.env.DB, { ts, id: job.id, rev: job.rev });
  if (!published) return reviewPage(c, ctx, (await loadJob(c.env.DB, job.id)) ?? job, { error: 'job.err.stale' }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=published`);
});

// ── 마감: 게재 중 → 마감. 다시 열기는 없다.

bizJobs.post('/jobs/:id/close', async (c) => {
  const x = await requireJob(c);
  if (x instanceof Response) return x;
  const { ctx, job } = x;
  if (job.status !== 'published') return reviewPage(c, ctx, job, { error: 'job.err.not_published' }, 400);
  const closed = await closeJob(c.env.DB, job.id);
  if (!closed) return reviewPage(c, ctx, job, { error: 'job.err.stale' }, 400);
  return c.redirect(`/biz/jobs/${job.id}?ok=closed`);
});
