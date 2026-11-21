// 구직자 지원 (T-08): /jobs/:id/apply (지원), /my/applications... (지원 현황·한 건·첨부 내려받기·취소). 구직자만 쓴다.
//
// 원칙 (CLAUDE.md 규칙 1·3·4·5, docs/ARCHITECTURE.md 11장)
// - 지원은 구직자 본인이 2단계 화면에서 "지원하기" 를 눌렀을 때만 생긴다. 운영자·시스템이 고르거나 대신 내는 길은 없다.
// - 지원 가능 여부는 lib/application.applyBlocks, 동의 필요 여부는 consentNeed, 복사본은 buildSnapshot, 취소 가능 여부는 canWithdraw.
//   여기서 조건을 따로 만들지 않는다. DB 문장(db/applications.insertApplication)도 공개 조건·중복을 한 번 더 확인한다.
// - 상태는 이벤트로만 바뀐다: 이 파일에서 상태를 바꾸는 것은 취소(withdrawApplication = 'withdrawn' 이벤트 + nextStatus) 하나뿐이다.
// - 열람 권한은 authz.canViewApplication. 구직자 본인이 자기 지원서를 보는 화면은 access_log 에 남기지 않는다
//   (이력서 화면과 같다). 첨부파일 내려받기는 serveApplicationFile 이 확인·기록한다.
// - 개인정보: 이력서·지원서 내용·이름·이메일·파일명을 console·메일·주소에 넣지 않는다. 기업 알림 메일은 공고 제목과 주소뿐.
// - 모든 응답은 Cache-Control: private, no-store. /jobs/:id/apply 는 page-cache 를 거치지 않는다 (미들웨어를 붙이지 않음).
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { flagsOf, now, type AppEnv, type SessionUser } from '../env';
import { loadActor } from '../lib/actor';
import {
  CROSS_BORDER_VERSION, WITHDRAWABLE, applyBlocks, buildSnapshot, canWithdraw, consentAt, consentNeed, newApplicantMail,
  type ApplyBlock, type ConsentNeed,
} from '../lib/application';
import { serveApplicationFile } from '../lib/application-files';
import { requireRole } from '../lib/auth';
import { canApply, canViewApplication, type ApplicationRef, type JobRef } from '../lib/authz';
import { importEncKey } from '../lib/crypto';
import { sendMail } from '../lib/email';
import { t } from '../lib/i18n';
import { isJobId, isPubliclyVisible } from '../lib/public-jobs';
import {
  inputFromResume, openResume, readResumeForm, resumeReadyToApply, sealResume, validateResume,
  type ResumeBody, type ResumeFieldError, type ResumeInput,
} from '../lib/resume';
import { copyResumeFile, deleteResumeFile } from '../lib/resume-files';
import { nextStatus, type AppStatus } from '../lib/rules';
import { render, renderError } from '../render';
import {
  ApplicationList, ApplicationPage, ApplyChooseResume, ApplyForm, ApplyNeedResume, WithdrawConfirm,
  type ApplyJob, type ResumeChoice, type SnapshotState,
} from '../views/applications';
import {
  companyMemberEmails, getOwnApplication, hasApplied, insertApplication, listOwnApplications, memberCounts, withdrawApplication,
  type ApplicationRow,
} from '../db/applications';
import { listVisibleAppliedJobIds } from '../db/application-views';
import { findCompanyBrief } from '../db/companies';
import { loadJob } from '../db/jobs';
import { findPublicJob } from '../db/public-jobs';
import { getResume, listResumes, type ResumeRow } from '../db/resumes';

const NO_STORE = 'private, no-store';
/** 새 지원자 알림 메일을 보낼 기업 담당자 수 상한 (기업당 담당자는 초대 한도로 10명 안팎). */
const NOTIFY_MAX = 10;

/** 캐시 금지 머리글은 권한 검사보다 먼저 건다 (403·로그인 리다이렉트에도 붙게). */
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', NO_STORE);
};

/** 오류는 종류만 남긴다 (내용·주소·이름을 넣지 않는다). */
const logFail = (what: string) => console.error(`apply: ${what} failed`);

const key = (c: Context<AppEnv>) => importEncKey(c.env.ENC_KEY);

async function tryOpen(k: CryptoKey, stored: string): Promise<ResumeBody | null> {
  if (!stored) return null;
  try {
    return await openResume(k, stored);
  } catch {
    return null;
  }
}

/** 어느 행도 가리키지 않게 된 R2 파일을 지운다. 실패해도 요청은 실패시키지 않는다 (고아 파일 → T-12 정리 작업). */
async function cleanup(c: Context<AppEnv>, r2Key: string | null): Promise<void> {
  if (!r2Key) return;
  try {
    await deleteResumeFile(c.env, r2Key);
  } catch {
    logFail('file cleanup');
  }
}

// ── 공고 읽기

interface ApplyJobCtx extends ApplyJob { companyId: string; ref: JobRef; visible: boolean }

/**
 * 지원할 공고. 화면에 보일 제목·기업명은 공개 질의(findPublicJob: 기업명 비공개면 이름이 NULL)에서,
 * 공개 여부 판단에 쓸 값(상태·기업 검증·헤드헌터 공고·직군·마감일)과 기업 id 는 공고 행 + 기업 행에서 읽어
 * lib/public-jobs.isPubliclyVisible 로 판단한다. 공개 질의가 null 이면 보이지 않는 공고다.
 */
async function loadApplyJob(c: Context<AppEnv>, id: string, ts: number): Promise<ApplyJobCtx | null> {
  if (!isJobId(id)) return null;
  const flags = flagsOf(c.env);
  const [pub, row] = await Promise.all([findPublicJob(c.env.DB, { id, flags, now: ts }), loadJob(c.env.DB, id)]);
  if (!pub || !row) return null;
  const co = await findCompanyBrief(c.env.DB, row.company_id);
  const visible = !!co && isPubliclyVisible({
    status: row.status, agency_id: row.agency_id, job_family: row.job_family, closes_at: row.closes_at, company_verify_status: co.verify_status,
  }, { flags, now: ts });
  return {
    id, title: pub.title_ko, companyName: pub.company_name, companyId: row.company_id,
    ref: { company_id: row.company_id, agency_id: row.agency_id, created_by: row.created_by }, visible,
  };
}

/** 이미 지원한 공고면 그 지원 화면으로 (없으면 목록으로). */
async function existingApplicationHref(c: Context<AppEnv>, jobId: string, seekerId: string): Promise<string> {
  const mine = await listOwnApplications(c.env.DB, seekerId);
  const a = mine.find((x) => x.job_id === jobId);
  return a ? `/my/applications/${a.id}` : '/my/applications';
}

// ════════════════════════════════════════ /jobs/:id/apply (index.tsx 에서 /jobs 에 붙인다)

export const apply = new Hono<AppEnv>();

// 이 경로에만 미들웨어를 붙인다 — '*' 로 붙이면 같은 /jobs 아래의 공개 공고 화면까지 구직자 전용이 된다.
apply.use('/:id/apply', noStore, requireRole('seeker'));

interface StepTwo {
  job: ApplyJobCtx; row: ResumeRow; body: ResumeBody; input: ResumeInput; errors: ResumeFieldError[];
  includeFile: boolean; need: ConsentNeed; consentGiven: boolean; error?: string;
}

const stepTwo = (c: Context<AppEnv>, s: StepTwo, status: 200 | 400 = 200) =>
  render(c, (
    <ApplyForm locale={c.var.locale} job={s.job} resumeId={s.row.id} input={s.input} errors={s.errors}
      file={s.row.file_r2_key ? s.body.file : null} includeFile={s.includeFile} need={s.need} consentGiven={s.consentGiven} error={s.error} />
  ), 'apply.title', status);

/** 1단계 목록: 열 수 있는 이력서만 (열 수 없는 것은 이력서 화면에서 지우도록 안내되어 있다). 지원 가능 여부는 resumeReadyToApply. */
async function resumeChoices(c: Context<AppEnv>, user: SessionUser): Promise<ResumeChoice[]> {
  const rows = await listResumes(c.env.DB, user.id);
  const k = await key(c);
  const out: ResumeChoice[] = [];
  for (const row of rows) {
    const body = await tryOpen(k, row.body);
    if (!body) continue;
    // 파일 정보가 있어도 파일 키가 없으면 첨부가 없는 것으로 본다 (지원할 때 복사할 수 없다).
    const usable = row.file_r2_key ? body : { ...body, file: null };
    out.push({ id: row.id, title: row.title, headline: body.headline, isDefault: row.is_default === 1, ready: resumeReadyToApply(usable) });
  }
  return out;
}

/** 내 이력서 하나를 연다. 남의 것·없는 것·열 수 없는 것은 null. */
async function loadOwnResume(c: Context<AppEnv>, id: string, userId: string): Promise<{ row: ResumeRow; body: ResumeBody } | null> {
  const row = await getResume(c.env.DB, id, userId);
  if (!row) return null;
  const body = await tryOpen(await key(c), row.body);
  return body ? { row, body } : null;
}

apply.get('/:id/apply', async (c) => {
  const user = c.var.user!;
  const job = await loadApplyJob(c, c.req.param('id'), now());
  if (!job || !job.visible) return renderError(c, 404);
  if (await hasApplied(c.env.DB, job.id, user.id)) return c.redirect(await existingApplicationHref(c, job.id, user.id));

  const choices = await resumeChoices(c, user);
  const ready = choices.filter((r) => r.ready);
  if (ready.length === 0) return render(c, <ApplyNeedResume locale={c.var.locale} job={job} hasAny={choices.length > 0} />, 'apply.title');

  const chosen = c.req.query('resume');
  if (!chosen) {
    const selected = (ready.find((r) => r.isDefault) ?? ready[0]!).id;
    return render(c, <ApplyChooseResume locale={c.var.locale} job={job} items={choices} selected={selected} />, 'apply.title');
  }

  // 2단계: 고른 이력서로 채운 폼. 아직 아무것도 저장하지 않는다.
  const own = await loadOwnResume(c, chosen, user.id);
  if (!own) return renderError(c, 404);
  if (!choices.find((r) => r.id === own.row.id)?.ready) {
    return render(c, <ApplyChooseResume locale={c.var.locale} job={job} items={choices} selected={ready[0]!.id} error="apply.err.resume_not_ready" />, 'apply.title', 400);
  }
  const need = consentNeed(await memberCounts(c.env.DB, job.companyId));
  return stepTwo(c, {
    job, row: own.row, body: own.body, input: inputFromResume(own.row.title, own.body), errors: [],
    includeFile: true, need, consentGiven: false,
  });
});

/** 막는 사유 → 화면 문구. already_applied 는 문구 대신 기존 지원으로 보낸다. */
function blockMessage(blocks: ApplyBlock[], fileLost: boolean): string {
  if (blocks.includes('resume_not_ready')) return fileLost ? 'apply.err.file_lost' : 'apply.err.not_ready';
  if (blocks.includes('consent_required')) return 'apply.err.consent_required';
  return 'apply.err.closed';
}

apply.post('/:id/apply', async (c) => {
  const user = c.var.user!;
  const ts = now();

  // (a) 구직자 확인(requireRole) → 공고(공개 여부 포함) → 고른 이력서(내 것이고 열 수 있어야 함). 공고가 보이지 않으면 파일을 만들기 전에 404.
  const actor = await loadActor(c.env, user);
  const job = await loadApplyJob(c, c.req.param('id'), ts);
  if (!job || !job.visible) return renderError(c, 404);
  const f = await c.req.parseBody();
  const own = await loadOwnResume(c, typeof f.resume_id === 'string' ? f.resume_id : '', user.id);
  if (!own) return renderError(c, 404);
  const { row, body } = own;

  // (b) 이번 지원에만 쓸 항목: 이력서 폼과 같은 검사. 이름표(title)는 화면에 없으므로 이력서의 것을 넣어 검사만 통과시킨다 (저장하지 않는다).
  const input = readResumeForm({ ...f, title: row.title });
  const v = validateResume(input);
  const hasFile = !!(row.file_r2_key && body.file);
  const include = hasFile && f.include_file === '1';

  // (c) 국외 이전 동의: 필요 여부는 지금의 담당자 구성으로 정한다. 체크값은 필요할 때만 저장된다(consentAt).
  const need = consentNeed(await memberCounts(c.env.DB, job.companyId));
  const given = f.consent === '1';
  const again = (error: string | undefined, errors: ResumeFieldError[] = []) =>
    stepTwo(c, { job, row, body, input, errors, includeFile: include, need, consentGiven: given, error }, 400);
  if (!v.ok) return again(undefined, v.errors);

  const blocksFor = async (copied: boolean) => applyBlocks({
    canApply: canApply(actor),
    jobVisible: job.visible,
    alreadyApplied: await hasApplied(c.env.DB, job.id, user.id),
    resumeReady: resumeReadyToApply(buildSnapshot(body, v.fields, { include, copied })),
    consentNeed: need,
    consentGiven: given,
  });

  // 미리 확인: 파일을 복사하기 전에, 복사가 된다고 보고 막히는 사유가 있는지 본다 (필요 없는 R2 쓰기를 하지 않으려고).
  // 최종 판단은 아래 (e) 에서 실제 복사 결과로 다시 한다.
  const pre = await blocksFor(include);
  if (pre.includes('already_applied')) return c.redirect(await existingApplicationHref(c, job.id, user.id));
  if (pre.length) return again(blockMessage(pre, false));

  // (d) 첨부파일: 지원서는 자기 R2 객체를 따로 가진다 (이력서를 고치거나 지워도 그대로). 복사에 실패하면 첨부 없이 진행한다.
  let fileKey: string | null = null;
  if (include) {
    try {
      fileKey = await copyResumeFile(c.env, row.file_r2_key!);
    } catch {
      logFail('file copy');
      fileKey = null;
    }
  }
  const copied = fileKey !== null;
  const fileLost = include && !copied;

  // (e) 복사본과 최종 판단. 첨부가 빠져서 지원할 수 없게 되면 내지 않고 알린다.
  const snapshot = buildSnapshot(body, v.fields, { include, copied });
  const blocks = await blocksFor(copied);
  if (blocks.length) {
    await cleanup(c, fileKey);
    if (blocks.includes('already_applied')) return c.redirect(await existingApplicationHref(c, job.id, user.id));
    return again(blockMessage(blocks, fileLost));
  }

  // (f) 저장: 한 문장 안에서 공개 조건·중복을 다시 확인한다. 들어가지 않았거나 예외면 방금 복사한 파일을 지운다.
  const id = crypto.randomUUID();
  let inserted = false;
  try {
    inserted = await insertApplication(c.env.DB, {
      id, jobId: job.id, seekerId: user.id, resumeId: row.id, snapshot: await sealResume(await key(c), snapshot), fileKey,
      consentAt: consentAt(need, given, ts), consentVersion: CROSS_BORDER_VERSION, ts,
    }, flagsOf(c.env));
  } catch (e) {
    await cleanup(c, fileKey);
    throw e;
  }
  if (!inserted) {
    await cleanup(c, fileKey);
    if (await hasApplied(c.env.DB, job.id, user.id)) return c.redirect(await existingApplicationHref(c, job.id, user.id));
    return again('apply.err.closed');
  }

  // (g) 저장된 뒤에만 기업에 알린다. 실패해도 지원은 그대로이고 구직자에게 오류로 보이지 않는다.
  await notifyCompany(c, job);

  // (h) 결과 화면
  return c.redirect(`/my/applications/${id}?ok=${fileLost ? 'applied_nofile' : 'applied'}`);
});

/** 기업 담당자(활성 계정)에게 "새 지원자" 메일. 공고 제목과 주소만 들어간다 (newApplicantMail). 구직자 정보는 넣지 않는다. */
async function notifyCompany(c: Context<AppEnv>, job: ApplyJobCtx): Promise<void> {
  try {
    const to = (await companyMemberEmails(c.env.DB, job.companyId)).slice(0, NOTIFY_MAX);
    if (!to.length) return;
    const m = newApplicantMail({ title_ko: job.title }, c.env.APP_ORIGIN, t);
    for (const addr of to) {
      try {
        if (!(await sendMail(c.env, { to: addr, subject: m.subject, text: m.text, template: 'new_applicant' }))) logFail('notify');
      } catch {
        logFail('notify');
      }
    }
  } catch {
    logFail('notify');
  }
}

// ════════════════════════════════════════ /my/applications

export const applications = new Hono<AppEnv>();

applications.use('*', noStore, requireRole('seeker'));

const PAGE_OK: Record<string, string> = { applied: 'app.ok.applied', applied_nofile: 'app.ok.applied_nofile', withdrawn: 'app.ok.withdrawn' };

applications.get('/', async (c) => {
  const user = c.var.user!;
  const [rows, visible] = await Promise.all([
    listOwnApplications(c.env.DB, user.id),
    listVisibleAppliedJobIds(c.env.DB, user.id, flagsOf(c.env), now()),
  ]);
  return render(c, <ApplicationList locale={c.var.locale} rows={rows} visible={new Set(visible)} />, 'app.list.title');
});

interface OwnApp { row: ApplicationRow; job: ApplyJob; ref: ApplicationRef & { id: string; file_r2_key: string | null } }

/**
 * 내 지원 한 건 + 권한 확인. 남의 것·없는 것은 null (호출부는 404).
 * 제목·기업명(비공개면 NULL)은 내 지원 현황 질의에서, 권한 판단용 공고 정보는 공고 행에서 읽는다.
 */
async function loadOwnApp(c: Context<AppEnv>): Promise<OwnApp | null> {
  const user = c.var.user!;
  const row = await getOwnApplication(c.env.DB, c.req.param('id') ?? '', user.id);
  if (!row) return null;
  const [jobRow, mine, actor] = await Promise.all([loadJob(c.env.DB, row.job_id), listOwnApplications(c.env.DB, user.id), loadActor(c.env, user)]);
  if (!jobRow) return null;
  const ref = {
    id: row.id, file_r2_key: row.file_r2_key, seeker_id: row.seeker_id, status: row.status, cross_border_consent_at: row.cross_border_consent_at,
    job: { company_id: jobRow.company_id, agency_id: jobRow.agency_id, created_by: jobRow.created_by },
  };
  if (!canViewApplication(actor, ref).allow) return null;
  const listed = mine.find((x) => x.id === row.id);
  return { row, ref, job: { id: row.job_id, title: listed?.title_ko ?? jobRow.title_ko, companyName: listed ? listed.company_name : null } };
}

async function snapshotOf(c: Context<AppEnv>, row: ApplicationRow): Promise<SnapshotState> {
  if (row.status === 'withdrawn' || !row.resume_snapshot) return { kind: 'deleted' };
  const body = await tryOpen(await key(c), row.resume_snapshot);
  return body ? { kind: 'ok', body } : { kind: 'unavailable' };
}

const appPage = async (c: Context<AppEnv>, x: OwnApp, msg: { ok?: string; error?: string } = {}, status: 200 | 400 = 200) =>
  render(c, (
    <ApplicationPage locale={c.var.locale} row={x.row} job={x.job} snapshot={await snapshotOf(c, x.row)} canWithdraw={canWithdraw(x.row.status)} {...msg} />
  ), 'app.page.title', status);

applications.get('/:id', async (c) => {
  const x = await loadOwnApp(c);
  if (!x) return renderError(c, 404);
  return appPage(c, x, { ok: PAGE_OK[c.req.query('ok') ?? ''] });
});

// 첨부파일: 권한 확인 → 열람 기록 → 복호화 → 전송은 serveApplicationFile 만 한다.
applications.get('/:id/file', async (c) => {
  const x = await loadOwnApp(c);
  if (!x) return renderError(c, 404);
  const s = await snapshotOf(c, x.row);
  if (s.kind !== 'ok') return renderError(c, 404);
  const res = await serveApplicationFile(c.env, await loadActor(c.env, c.var.user!), x.ref, s.body.file, null);
  return res ?? renderError(c, 404);
});

// ── 취소: 확인 화면(GET) → POST. 상태를 바꾸는 유일한 길이며 'withdrawn' 이벤트로 남는다 (규칙 3).

applications.get('/:id/withdraw', async (c) => {
  const x = await loadOwnApp(c);
  if (!x) return renderError(c, 404);
  if (!canWithdraw(x.row.status)) return appPage(c, x, { error: 'app.err.cannot_withdraw' }, 400);
  return render(c, <WithdrawConfirm locale={c.var.locale} id={x.row.id} job={x.job} />, 'app.withdraw.title');
});

applications.post('/:id/withdraw', async (c) => {
  const user = c.var.user!;
  const x = await loadOwnApp(c);
  if (!x) return renderError(c, 404);
  if (!canWithdraw(x.row.status)) return appPage(c, x, { error: 'app.err.cannot_withdraw' }, 400);
  const done = await withdrawApplication(c.env.DB, {
    id: x.row.id, seekerId: user.id, newStatus: nextStatus(x.row.status as AppStatus, 'withdrawn'), fromStatuses: WITHDRAWABLE, ts: now(),
  });
  if (!done) {
    // 그사이 상태가 바뀌었다 (다른 창에서 취소했거나 기업 쪽에서 끝났다). 지금 상태를 다시 보여준다.
    const fresh = await loadOwnApp(c);
    if (!fresh) return renderError(c, 404);
    return appPage(c, fresh, { error: 'app.err.cannot_withdraw' }, 400);
  }
  // DB 가 더 이상 파일을 가리키지 않게 된 뒤에 지운다. 실패하면 고아 파일 → T-12 정리 작업.
  await cleanup(c, x.row.file_r2_key);
  return c.redirect(`/my/applications/${x.row.id}?ok=withdrawn`);
});

