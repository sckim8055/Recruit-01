// 기업의 지원자 화면 (T-09a): /biz/jobs/:id/applicants (목록), /biz/applications/:id (지원서), /biz/applications/:id/file (첨부).
// 기업 → 지원자 메일 (T-09b): 면접 요청 (/biz/applications/:id/interview/{compose,preview,send}), 불합격 통보 (/biz/jobs/:id/applicants/reject/{confirm,send}).
//
// 원칙 (CLAUDE.md 규칙 1·3·4·5, docs/ARCHITECTURE.md 12장)
// - 기업 id 는 로그인 사용자의 소속(biz-ctx.ts)에서만 정한다. 남의 공고·남의 지원서는 있는지도 알리지 않고 404.
// - 목록(listJobApplications)에는 내용이 없다. 지원서 내용은 lib/applicants.openApplication 만 연다 (권한 → 복호화 → access_log → 'viewed').
//   이 파일은 resume_snapshot 을 풀지 않고, 상태를 바꾸지 않고, application_events 에 쓰지 않는다.
// - 첨부는 lib/applicants.downloadApplicationFile 만 쓴다 (openApplication 을 부르지 않는다 — 기록이 두 번 남지 않게).
// - 지원서 화면은 요청 한 번에 openApplication 한 번. 캐시·미리 읽기 없음. HEAD·브라우저 미리 가져오기는 기록 전에 거절한다 (guards.humanGetOnly, biz.tsx 에서 붙임).
// - 정렬·추천·메모·내보내기·전달·상태 변경 버튼은 만들지 않는다.
// - 메일(T-09b)은 lib/applicant-mail 의 sendInterviewRequest · sendRejection 만 보낸다 (권한·상태·횟수 → 복호화 → 발송 → 이벤트·상태 기록이 그 안에 있다).
//   이 파일은 받는 주소를 모르고(지원서를 풀지 않는다), 메일 화면에서는 openApplication 을 부르지 않는다 (열람 기록이 더 남지 않게).
//   메시지 글은 POST 본문으로만 오가며 주소·로그·email_log 에 남지 않는다. 보낸 뒤에는 지원자 목록으로 리다이렉트한다 (지원서 화면으로 가면 열람이 또 기록되므로).
//   관리자·운영자가 지원자에게 메일을 보내는 경로는 없다.
import { Hono, type Context } from 'hono';
import { now, type AppEnv, type Env, type Locale } from '../env';
import { INTERVIEW_MAIL_MAX, readMessage, rejectMail, REJECT_BATCH_MAX, sendInterviewRequest, sendRejection, type MailResult } from '../lib/applicant-mail';
import { downloadApplicationFile, openApplication, refOf } from '../lib/applicants';
import { canEditJob, canViewApplication } from '../lib/authz';
import { t } from '../lib/i18n';
import { MESSAGE_MAX, translateMessage } from '../lib/localize/message';
import { availableEngines } from '../lib/localize';
import { QUOTA_MSG, limitsOf, quotaText, takeCompanyMail, takeLocalize, type QuotaTake } from '../lib/quota';
import { render, renderError } from '../render';
import { ApplicantList, CompanyApplicationNotice, CompanyApplicationPage } from '../views/applicants';
import { InterviewCompose, InterviewPreview, isMailOpen, MailResultPage, RejectConfirm, tf, type MailHeadInfo } from '../views/applicant-mail';
import { requireCompany } from './biz-company';
import { countEvents, getApplicationWithJob, listJobApplications, type ApplicationWithJob } from '../db/applicants';
import { countInterviewMailsByJob } from '../db/applicant-views';
import { loadJob, type JobRow } from '../db/jobs';
import type { CompanyCtx } from './biz-ctx';

export const bizApplicants = new Hono<AppEnv>();

// ── 지원자 목록

const batchNum = (q: (k: string) => string | undefined, k: string) => {
  const v = q(k) ?? '';
  return /^\d{1,2}$/.test(v) && Number(v) <= REJECT_BATCH_MAX ? Number(v) : 0;
};

/** 결과 표시: ?ok=interview, ?ok=rejected&sent=N&failed=M (숫자만, 0~REJECT_BATCH_MAX). */
function listOk(l: Locale, q: (k: string) => string | undefined): string[] {
  const ok = q('ok');
  if (ok === 'interview') return [t(l, 'aplm.ok.interview')];
  if (ok !== 'rejected') return [];
  const num = (k: string) => batchNum(q, k);
  const sent = num('sent'), failed = num('failed');
  return [
    ...(sent > 0 ? [tf(l, 'aplm.ok.rejected', { sent })] : []),
    ...(failed > 0 ? [tf(l, 'aplm.ok.rejected_failed', { failed })] : []),
  ];
}

async function renderList(c: Context<AppEnv>, ctx: CompanyCtx, job: JobRow, o: { ok?: string[]; error?: string; status?: 200 | 400 } = {}) {
  const [rows, interviewCounts] = await Promise.all([listJobApplications(c.env.DB, job.id), countInterviewMailsByJob(c.env.DB, job.id)]);
  return render(c, (
    <ApplicantList locale={c.var.locale} job={job} rows={rows} hq={ctx.actor.hqCompanyIds.includes(job.company_id)}
      interviewCounts={interviewCounts} ok={o.ok} error={o.error} />
  ), 'apl.list.title', o.status ?? 200);
}

/** 이 기업의 공고만 (공고 수정 권한과 같은 조건). 없거나 남의 것이면 null → 404. */
async function loadCompanyJob(c: Context<AppEnv>, ctx: CompanyCtx): Promise<JobRow | null> {
  const job = await loadJob(c.env.DB, c.req.param('id') ?? '');
  return job && canEditJob(ctx.actor, job) ? job : null;
}

bizApplicants.get('/jobs/:id/applicants', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const job = await loadCompanyJob(c, ctx);
  if (!job) return renderError(c, 404);
  const q = (k: string) => c.req.query(k);
  return renderList(c, ctx, job, { ok: listOk(c.var.locale, q), error: rejectLimitNote(c.var.locale, c.env, q) });
});

/** 메일 한도에 걸린 몫의 안내 (T-05c). 숫자는 지금 설정의 한도. */
function mailLimitText(l: Locale, env: Env, pool: 'company' | 'site'): string {
  const L = limitsOf(env);
  return pool === 'company' ? quotaText(l, QUOTA_MSG.mailCompany, { n: L.MAIL_PER_COMPANY_DAY }) : quotaText(l, QUOTA_MSG.mailSite, { n: L.MAIL_SITE_DAY });
}

/** 불합격 통보 결과의 한도 안내: ?ok=rejected&limited=K&pool=company|site (숫자·이름만). K 가 0 이면 없음. */
function rejectLimitNote(l: Locale, env: Env, q: (k: string) => string | undefined): string | undefined {
  if (q('ok') !== 'rejected') return undefined;
  const unsent = batchNum(q, 'limited');
  if (!unsent) return undefined;
  const pool = q('pool') === 'site' ? 'site' : 'company';
  return `${quotaText(l, QUOTA_MSG.rejectUnsent, { unsent })} ${mailLimitText(l, env, pool)}`;
}

/** 메일 한도 잡기 결과 → 안내 글 (거절일 때만). */
const mailRefusal = (l: Locale, env: Env, q: QuotaTake): string | null =>
  q.ok ? null : mailLimitText(l, env, q.pool === 'site' ? 'site' : 'company');

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
  if (r.ok) {
    // 메일 칸(T-09b): 보낼 수 있는 상태일 때만 보낸 횟수를 읽는다. 지원서는 위에서 한 번만 열었다.
    const sent = isMailOpen(r.status) ? await countEvents(c.env.DB, app.id, 'interview_mail') : 0;
    return render(c, <CompanyApplicationPage locale={l} app={app} status={r.status} body={r.body} mail={{ sent, replyTo: ctx.user.email }} />, 'apl.page.title');
  }
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

// ── 면접 요청 (T-09b): 쓰기 → 미리 보기(자동 번역) → 보내기. 지원서를 열지 않는다 (개인정보 없는 화면).

/** 메일 화면의 머리말: 공고 제목·지원 순서 번호(목록과 같은 순서)·지원일·상태. */
async function headOf(c: Context<AppEnv>, app: ApplicationWithJob): Promise<MailHeadInfo> {
  const rows = await listJobApplications(c.env.DB, app.job_id);
  const i = rows.findIndex((r) => r.id === app.id);
  return { jobId: app.job_id, jobTitle: app.job_title_ko, no: i >= 0 ? i + 1 : null, createdAt: app.created_at, status: app.status };
}

/**
 * 면접 요청 화면에 들어올 수 있는가. 남의 것 → 404, 취소됨·국외 이전 동의 없음 → 지원서 화면과 같은 안내, 끝난 지원·횟수 초과 → 결과 안내.
 * 최종 판단은 sendInterviewRequest 가 다시 한다 (여기는 번역 엔진을 부르기 전에 걸러 내는 것).
 */
async function interviewGate(c: Context<AppEnv>, ctx: CompanyCtx): Promise<{ app: ApplicationWithJob; sent: number } | Response> {
  const app = await loadCompanyApp(c, ctx);
  if (!app) return renderError(c, 404);
  const l = c.var.locale;
  const d = canViewApplication(ctx.actor, refOf(app));
  if (!d.allow) {
    if (d.why === 'withdrawn') return render(c, <CompanyApplicationNotice locale={l} jobId={app.job_id} kind="withdrawn" />, 'apl.page.title', 400);
    if (d.why === 'no_cross_border_consent') return render(c, <CompanyApplicationNotice locale={l} jobId={app.job_id} kind="no_consent" />, 'apl.page.title', 403);
    return renderError(c, 404);
  }
  if (!isMailOpen(app.status)) return result(c, app.job_id, 'not_open');
  const sent = await countEvents(c.env.DB, app.id, 'interview_mail');
  if (sent >= INTERVIEW_MAIL_MAX) return result(c, app.job_id, 'limit');
  return { app, sent };
}

function result(c: Context<AppEnv>, jobId: string, why: Exclude<MailResult, { ok: true }>['why']) {
  const l = c.var.locale;
  return render(c, <MailResultPage locale={l} jobId={jobId} text={tf(l, `aplm.res.${why}`, { max: INTERVIEW_MAIL_MAX })} />, 'aplm.res.title', why === 'changed' ? 200 : 400);
}

const formText = (v: unknown) => (typeof v === 'string' ? v.slice(0, MESSAGE_MAX * 2) : '');
const messageError = (l: Locale, why: 'required' | 'too_long') => tf(l, `aplm.err.${why}`, { max: MESSAGE_MAX });

/**
 * 숨은 칸으로 돌아온 번역: readMessage 와 같은 정리(줄바꿈·제어 문자·앞뒤 공백). 비었거나, "원문만" 이거나,
 * 원문보다 지나치게 길면(4배 + 200자, localize/message 와 같은 기준) 버린다 → 원문만.
 */
function cleanTranslation(raw: unknown, original: string, onlyOriginal: boolean): string | null {
  if (onlyOriginal || typeof raw !== 'string') return null;
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!s || s.length > original.length * 4 + 200) return null;
  return s === original.trim() ? null : s;
}

// "고치기": 미리 보기에서 쓴 글을 가지고 쓰기 화면으로 (POST — 글을 주소에 넣지 않는다).
bizApplicants.post('/applications/:id/interview/compose', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const g = await interviewGate(c, ctx);
  if (g instanceof Response) return g;
  const f = await c.req.parseBody();
  return render(c, (
    <InterviewCompose locale={c.var.locale} head={await headOf(c, g.app)} appId={g.app.id} sent={g.sent} replyTo={ctx.user.email} text={formText(f.message)} />
  ), 'aplm.iv.title');
});

bizApplicants.post('/applications/:id/interview/preview', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const g = await interviewGate(c, ctx);
  if (g instanceof Response) return g;
  const l = c.var.locale;
  const f = await c.req.parseBody();
  const m = readMessage(f.message);
  const head = await headOf(c, g.app);
  if (!m.ok) {
    return render(c, (
      <InterviewCompose locale={l} head={head} appId={g.app.id} sent={g.sent} replyTo={ctx.user.email} text={formText(f.message)} error={messageError(l, m.why)} />
    ), 'aplm.iv.title', 400);
  }
  // 하루 번역 한도 (T-05c): 공고 현지화와 같은 기업 몫 → 사이트 몫. 엔진이 없으면 한도를 쓰지 않는다 (translateMessage 가 no_engine).
  // 한도에 걸리면 번역 없이 원문만 — 보내기는 막지 않는다.
  if (availableEngines(c.env).length > 0) {
    const q = await takeLocalize(c.env, ctx.company.id, now());
    if (!q.ok) {
      const key = q.pool === 'company' ? QUOTA_MSG.previewCompany : QUOTA_MSG.previewSite;
      return render(c, (
        <InterviewPreview locale={l} head={head} appId={g.app.id} original={m.text} translation={null} limitNote={quotaText(l, key, { n: q.limit })}
          replyTo={ctx.user.email} sent={g.sent} />
      ), 'aplm.pv.title');
    }
  }
  // 엔진에는 메시지 글만 간다 (지원자 정보 없음). 실패해도 예외 없이 { ok: false }.
  const tr = await translateMessage(c.env, m.text);
  const same = tr.ok && tr.ko.trim() === m.text.trim();
  const translation = tr.ok && !same ? tr.ko : null;
  return render(c, (
    <InterviewPreview locale={l} head={head} appId={g.app.id} original={m.text} translation={translation}
      noTranslation={translation === null ? (same ? 'same' : 'failed') : undefined} replyTo={ctx.user.email} sent={g.sent} />
  ), 'aplm.pv.title');
});

bizApplicants.post('/applications/:id/interview/send', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const g = await interviewGate(c, ctx);
  if (g instanceof Response) return g;
  const l = c.var.locale;
  const f = await c.req.parseBody();
  const m = readMessage(f.message);
  if (!m.ok) {
    return render(c, (
      <InterviewCompose locale={l} head={await headOf(c, g.app)} appId={g.app.id} sent={g.sent} replyTo={ctx.user.email} text={formText(f.message)} error={messageError(l, m.why)} />
    ), 'aplm.iv.title', 400);
  }
  const onlyOriginal = f.only_original === '1';
  const translationKo = cleanTranslation(f.translation, m.text, onlyOriginal);
  // 하루 메일 한도 (T-05c): 보내기 전에 잡는다. 걸리면 보내지 않고(기록도 없음) 글을 지닌 미리 보기로.
  const limitError = mailRefusal(l, c.env, await takeCompanyMail(c.env, ctx.company.id, now()));
  if (limitError) {
    const hidden = typeof f.translation === 'string' ? cleanTranslation(f.translation, m.text, false) : null;
    return render(c, (
      <InterviewPreview locale={l} head={await headOf(c, g.app)} appId={g.app.id} original={m.text} translation={hidden}
        noTranslation={hidden === null ? 'failed' : undefined} onlyOriginal={onlyOriginal} replyTo={ctx.user.email} sent={g.sent}
        error={limitError} />
    ), 'aplm.pv.title', 400);
  }
  let r: MailResult;
  try {
    r = await sendInterviewRequest(c.env, ctx.actor, g.app, { companyName: ctx.company.name_ko, original: m.text, translationKo, replyTo: ctx.user.email }, t);
  } catch {
    r = { ok: false, why: 'mail_failed' }; // 메일 API 연결 오류 등. 기록은 발송 뒤에만 하므로 남지 않는다. 로그도 남기지 않는다.
  }
  if (r.ok) return c.redirect(`/biz/jobs/${g.app.job_id}/applicants?ok=interview`, 303);
  if (r.why === 'forbidden') return renderError(c, 404);
  if (r.why === 'mail_failed') {
    // 쓴 글을 그대로 두고 다시 보낼 수 있게 미리 보기 화면으로.
    const hidden = typeof f.translation === 'string' ? cleanTranslation(f.translation, m.text, false) : null;
    return render(c, (
      <InterviewPreview locale={l} head={await headOf(c, g.app)} appId={g.app.id} original={m.text} translation={hidden}
        noTranslation={hidden === null ? 'failed' : undefined} onlyOriginal={onlyOriginal} replyTo={ctx.user.email} sent={g.sent}
        error={t(l, 'aplm.res.mail_failed')} />
    ), 'aplm.pv.title', 400);
  }
  return result(c, g.app.job_id, r.why);
});

// ── 불합격 통보 (T-09b): 목록에서 고르기(또는 지원서 화면에서 한 건) → 확인(정해진 글) → 차례로 보내기.

/** 폼의 id 들 (중복 제거). 너무 많이 오면 바로 거절한다. */
async function readIds(c: Context<AppEnv>): Promise<string[] | 'too_many'> {
  const f = await c.req.parseBody({ all: true });
  const v = f.id;
  const arr = (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
  const ids = [...new Set(arr)];
  return ids.length > REJECT_BATCH_MAX ? 'too_many' : ids;
}

type RejectPick = { job: JobRow; ids: string[]; skipped: number } | Response;

/** 고른 지원이 모두 이 공고의 것인지 (아니면 404), 그중 보낼 수 있는 것(끝나지 않음, 본사 담당자는 동의한 것)만. */
async function pickForReject(c: Context<AppEnv>, ctx: CompanyCtx): Promise<RejectPick> {
  const job = await loadCompanyJob(c, ctx);
  if (!job) return renderError(c, 404);
  const l = c.var.locale;
  const ids = await readIds(c);
  if (ids === 'too_many') return renderList(c, ctx, job, { error: tf(l, 'aplm.err.too_many', { max: REJECT_BATCH_MAX }), status: 400 });
  if (!ids.length) return renderList(c, ctx, job, { error: t(l, 'aplm.err.none_selected'), status: 400 });
  const rows = new Map((await listJobApplications(c.env.DB, job.id)).map((r) => [r.id, r]));
  if (ids.some((id) => !rows.has(id))) return renderError(c, 404); // 다른 공고·다른 기업의 지원이 섞임
  const hq = ctx.actor.hqCompanyIds.includes(job.company_id);
  const ok = ids.filter((id) => {
    const r = rows.get(id)!;
    return isMailOpen(r.status) && !(hq && r.cross_border_consent_at === null);
  });
  if (!ok.length) return renderList(c, ctx, job, { error: t(l, 'aplm.err.none_open'), status: 400 });
  return { job, ids: ok, skipped: ids.length - ok.length };
}

bizApplicants.post('/jobs/:id/applicants/reject/confirm', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const p = await pickForReject(c, ctx);
  if (p instanceof Response) return p;
  const l = c.var.locale;
  const v = { companyName: ctx.company.name_ko, jobTitle: p.job.title_ko };
  // 보낼 글은 sendRejection 과 같은 함수·같은 문구 키로 만든다. 중국어 화면에는 같은 키의 중국어판을 참고로 (보내지 않음).
  const mail = rejectMail(v, t);
  const reference = l === 'zh' ? rejectMail(v, (_l, key) => t('zh', key)) : null;
  return render(c, (
    <RejectConfirm locale={l} job={p.job} ids={p.ids} skipped={p.skipped} mail={mail} reference={reference} replyTo={ctx.user.email} />
  ), 'aplm.rj.title');
});

bizApplicants.post('/jobs/:id/applicants/reject/send', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const p = await pickForReject(c, ctx);
  if (p instanceof Response) return p;
  let sent = 0, failed = p.skipped, limited = 0;
  let pool: 'company' | 'site' = 'company';
  // 차례로 하나씩 (요청 하나의 처리량을 작게, 메일 API 에 한꺼번에 몰리지 않게). 최대 REJECT_BATCH_MAX 건.
  for (const [i, id] of p.ids.entries()) {
    const app = await getApplicationWithJob(c.env.DB, id);
    if (!app || app.job_id !== p.job.id || !canEditJob(ctx.actor, refOf(app).job)) { failed++; continue; }
    // 하루 메일 한도 (T-05c): 한 통마다 보내기 전에. 처음 걸린 곳에서 멈추고 남은 건수는 보내지 않는다 (기록도 없다 — 핵심 함수는 보낸 뒤에만 기록한다).
    const q = await takeCompanyMail(c.env, ctx.company.id, now());
    if (!q.ok) {
      limited = p.ids.length - i;
      pool = q.pool === 'site' ? 'site' : 'company';
      break;
    }
    let r: MailResult;
    try {
      r = await sendRejection(c.env, ctx.actor, app, { companyName: ctx.company.name_ko, replyTo: ctx.user.email }, t);
    } catch {
      r = { ok: false, why: 'mail_failed' };
    }
    if (r.ok) sent++; else failed++;
  }
  const lim = limited ? `&limited=${limited}&pool=${pool}` : '';
  return c.redirect(`/biz/jobs/${p.job.id}/applicants?ok=rejected&sent=${sent}&failed=${failed}${lim}`, 303);
});
