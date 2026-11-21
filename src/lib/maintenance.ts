// 예약 작업 (T-12): 공고 자동 마감, 지원서 보관 기한·자동 종료·내용 삭제, 오래된 행 지우기, 사업자 서류 삭제, R2 고아 객체 정리, 하루 보고.
//
// 무료 플랜 한도 안에서 돌기 위해 cron 은 매시 정각에 한 번(wrangler.jsonc "0 * * * *") 실행되고, 한 번에 **한 단계만** 한다
// (어느 시각에 무엇을 하는지는 SCHEDULE). 단계마다 처리하는 행 수·D1 문장 수·R2 호출 수에 상한(CAPS)이 있고, 남은 것은 다음 차례에 한다.
// 어느 지점에서 끊겨도 다시 실행하면 이어서 한다 (모든 문장이 "아직 처리 전" 조건을 가진다 — src/db/maintenance.ts).
//
// 지우는 순서: **DB 를 먼저 지우고 그다음 R2 객체를 지운다.** R2 삭제가 실패하면 어느 행도 가리키지 않는 암호문 객체가 남고
// (rfiles/ 는 고아 객체 정리가 치운다), 반대 순서로 하다 끊기면 DB 가 없는 파일을 가리키게 된다.
//
// 기록: 실행마다 콘솔에 한 줄 `maint: step=<이름> ok|failed counts=<숫자 JSON>` 만 남긴다. 키·이메일·id·오류 내용은 남기지 않는다.
import type { Env } from '../env';
import { nextStatus, type AppStatus } from './rules';
import { sendMail } from './email';
import { t } from './i18n';
import { kstDate } from './jobs';
import { deleteResumeFile } from './resume-files';
import {
  ACCESS_LOG_KEEP, APPLICATION_AUTO_CLOSE_AFTER, APPLICATION_KEEP_AFTER_CLOSE, DAY, EMAIL_LOG_KEEP, ERASED_ROW_KEEP,
  JOB_CLOSE_NOTICE_BEFORE, JOB_STALE_AFTER, ORPHAN_MIN_AGE, VDOC_KEEP_AFTER_REVIEW,
} from './retention';
import {
  autoCloseApplications, closeJobsPastDeadline, closeStaleJobs, deleteMaintSetting, deleteOldMaintStats, deleteVerificationDocRows,
  dropOldRows, erasePurgedApplications, findReferencedFileKeys, listActiveMemberEmails, listAutoCloseCandidates,
  listExpiredVerificationDocs, listJobsNeedingCloseNotice, listPurgeCandidates, maintenanceCounts, markCloseNoticeSent, markPurgeAfter,
  putMaintSetting, unmarkPurgeAfter, type AutoCloseGroup, type CloseNoticeJobRow, type MaintCounts,
} from '../db/maintenance';
import { getSetting } from '../db/settings';
import { USAGE_KEEP_DAYS, kstDay } from './quota';

// ───────── 단계 이름·시간표·상한

export const STEP_NAMES = [
  'closeJobs', 'markApplications', 'purgeApplications', 'dropOldRows', 'purgeVerificationDocs', 'sweepOrphans', 'report',
] as const;
export type StepName = (typeof STEP_NAMES)[number];
export interface StepResult { step: StepName; done: Record<string, number> }
export type StepFn = (env: Env, nowSec: number) => Promise<StepResult>;

/**
 * UTC 시각(0~23) → 그 시각에 하는 단계. 한국 시간은 +9.
 * closeJobs 5번 · markApplications 4번 · purgeApplications 5번 · dropOldRows 3번 · sweepOrphans 4번 · purgeVerificationDocs 2번 · report 1번 (= 24).
 */
export const SCHEDULE: readonly StepName[] = [
  'report',               // 00 UTC = 09 KST — 전날(UTC) 하루의 집계를 보낸다
  'closeJobs',            // 01
  'markApplications',     // 02
  'purgeApplications',    // 03
  'dropOldRows',          // 04
  'sweepOrphans',         // 05
  'purgeVerificationDocs', // 06
  'closeJobs',            // 07
  'markApplications',     // 08
  'purgeApplications',    // 09
  'dropOldRows',          // 10
  'sweepOrphans',         // 11
  'closeJobs',            // 12
  'markApplications',     // 13
  'purgeApplications',    // 14
  'purgeVerificationDocs', // 15
  'sweepOrphans',         // 16
  'closeJobs',            // 17
  'markApplications',     // 18
  'purgeApplications',    // 19
  'dropOldRows',          // 20
  'sweepOrphans',         // 21
  'closeJobs',            // 22
  'purgeApplications',    // 23
];

export const REPORT_HOUR_UTC = 0;

export const stepForTime = (nowSec: number): StepName => SCHEDULE[Math.floor(nowSec / 3600) % 24]!;

/**
 * 한 번 실행의 상한. D1 문장은 batch 안의 문장도 하나씩 센다 (D1 은 batch 를 한 번으로 세지만 보수적으로) — 실행 1회 25개 이하,
 * R2 호출(list·delete)은 15개 이하. 집계 기록(읽기 1 + 쓰기 1)도 포함한다. 단계별 최대치는 test/maintenance.test.ts 가 센다.
 */
export const CAPS = {
  closeJobs: 10,            // 마감하는 공고 수 (마감일 지남 + 무수정 합계)
  closeNoticeJobs: 10,      // 안내할 공고 수
  closeNoticeMails: 10,     // 보내는 안내 메일 수 (담당자마다 한 통)
  markApplications: 50,     // 보관 기한을 붙이거나 떼거나 자동 종료하는 지원 수 (각각)
  purgeApplications: 10,    // 내용을 지우는 지원 수 (= R2 삭제 10 이하)
  dropRowsPerTable: 200,    // 표마다 지우는 행 수
  purgeVerificationDocs: 5, // 지우는 사업자 서류 수 (= R2 삭제 5 이하)
  orphanListPage: 100,      // R2 목록 한 쪽
  orphanDeletes: 10,        // 지우는 고아 객체 수
  refCheckChunk: 50,        // 참조 확인 IN (…) 한 번의 키 수
  statsKeepDays: 7,         // 일별 집계를 남기는 날 수
} as const;
export const BUDGET = { d1Statements: 25, r2Ops: 15 } as const;

export const ORPHAN_PREFIX = 'rfiles/';
export const VDOC_PREFIX = 'vdocs/';
export const ORPHAN_CURSOR_KEY = 'maint.rfiles_cursor';
const STATS_PREFIX = 'maint.stats.';

// ───────── 순수 도우미

const ALL_STATUSES: AppStatus[] = ['submitted', 'viewed', 'reviewing', 'interview', 'rejected', 'closed', 'withdrawn'];
/** 자동 종료가 상태를 바꾸는 상태 = 진행 중인 지원 (rules.nextStatus 로 정한다). */
export const AUTO_CLOSABLE: AppStatus[] = ALL_STATUSES.filter((s) => nextStatus(s, 'auto_closed') !== s);

/** 지원들을 지금 상태별로 묶고, 상태마다 nextStatus(상태, 'auto_closed') 를 계산한다. 바뀌지 않는 상태는 뺀다. */
export function autoCloseGroups(rows: Array<{ id: string; status: string }>): AutoCloseGroup[] {
  const by = new Map<string, string[]>();
  for (const r of rows) {
    if (!(ALL_STATUSES as string[]).includes(r.status)) continue;
    const to = nextStatus(r.status as AppStatus, 'auto_closed');
    if (to === r.status) continue;
    by.set(r.status, [...(by.get(r.status) ?? []), r.id]);
  }
  return [...by].map(([from, ids]) => ({ from, to: nextStatus(from as AppStatus, 'auto_closed'), ids }));
}

export interface R2ListedObject { key: string; uploaded: Date }

/** 지워도 되는 고아 객체: rfiles/ 아래, 올라온 지 ORPHAN_MIN_AGE 이상, 어느 행도 가리키지 않음. 앞에서부터 cap 개. */
export function pickOrphans(objects: R2ListedObject[], referenced: Set<string>, nowSec: number, cap: number): string[] {
  return objects
    .filter((o) => o.key.startsWith(ORPHAN_PREFIX) && isOldEnough(o, nowSec) && !referenced.has(o.key))
    .slice(0, cap)
    .map((o) => o.key);
}

export const isOldEnough = (o: R2ListedObject, nowSec: number): boolean =>
  o.uploaded instanceof Date && !Number.isNaN(o.uploaded.getTime()) && Math.floor(o.uploaded.getTime() / 1000) <= nowSec - ORPHAN_MIN_AGE;

export const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** 안내 메일에 적을 자동 마감 날짜: 마감일이 있으면 그 날, 없으면 (마지막 저장 + 30일)과 (지금 + 3일) 중 늦은 날. */
export function closeDateOf(job: Pick<CloseNoticeJobRow, 'closes_at' | 'updated_at'>, nowSec: number): number {
  return job.closes_at ?? Math.max(job.updated_at + JOB_STALE_AFTER, nowSec + JOB_CLOSE_NOTICE_BEFORE);
}

/** 자동 마감 안내 메일 (한국어 + 중국어). 공고 제목·날짜·기업 관리 화면 주소만 — 지원자 정보 없음. */
export function jobCloseNoticeMail(
  job: Pick<CloseNoticeJobRow, 'title_ko' | 'closes_at' | 'updated_at'>, nowSec: number, origin: string, tr: (l: 'ko' | 'zh', key: string) => string,
): { subject: string; text: string } {
  const url = `${origin.replace(/\/+$/, '')}/biz/jobs`;
  const title = (job.title_ko ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const date = kstDate(closeDateOf(job, nowSec));
  const reasonKey = job.closes_at != null ? 'mail.job_close.reason.deadline' : 'mail.job_close.reason.stale';
  const fill = (l: 'ko' | 'zh', s: string) =>
    s.replaceAll('{site}', tr(l, 'site.name')).replaceAll('{url}', url).replaceAll('{job}', title).replaceAll('{date}', date);
  const body = (l: 'ko' | 'zh') => fill(l, tr(l, 'mail.job_close.body').replaceAll('{reason}', tr(l, reasonKey)));
  return {
    subject: `[${tr('ko', 'site.name')}] ${fill('ko', tr('ko', 'mail.job_close.subject'))} / ${fill('zh', tr('zh', 'mail.job_close.subject'))}`,
    text: `${body('ko')}\n\n----------------------------------------\n\n${body('zh')}`,
  };
}

/** 이번 실행에 안내할 공고: 순서대로, 메일 상한을 넘기 전까지 (담당자가 없는 공고는 메일 없이 안내 완료로 본다). */
export function planNotices<J extends { company_id: string }>(jobs: J[], emailsByCompany: Map<string, string[]>, mailCap: number): Array<{ job: J; to: string[] }> {
  const out: Array<{ job: J; to: string[] }> = [];
  let mails = 0;
  for (const job of jobs) {
    const to = emailsByCompany.get(job.company_id) ?? [];
    if (mails + to.length > mailCap) break;
    mails += to.length;
    out.push({ job, to });
  }
  return out;
}

// ── 일별 집계 (site_settings 'maint.stats.<yyyy-mm-dd>', UTC 날짜)

export type DayStats = Record<string, Record<string, number>>;

export const utcDate = (nowSec: number): string => new Date(nowSec * 1000).toISOString().slice(0, 10);
export const statsKey = (nowSec: number): string => `${STATS_PREFIX}${utcDate(nowSec)}`;

export function parseStats(raw: string | null): DayStats {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: DayStats = {};
    for (const [step, counts] of Object.entries(v as Record<string, unknown>)) {
      if (!counts || typeof counts !== 'object') continue;
      const c: Record<string, number> = {};
      for (const [k, n] of Object.entries(counts as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) c[k] = n;
      out[step] = c;
    }
    return out;
  } catch {
    return {};
  }
}

/** 이번 실행 결과를 하루 집계에 더한다 (runs·failed 는 실행 횟수). 숫자만. */
export function mergeStats(prev: DayStats, step: StepName, ok: boolean, done: Record<string, number>): DayStats {
  const cur = { ...(prev[step] ?? {}) };
  cur.runs = (cur.runs ?? 0) + 1;
  if (!ok) cur.failed = (cur.failed ?? 0) + 1;
  for (const [k, n] of Object.entries(done)) if (Number.isFinite(n)) cur[k] = (cur[k] ?? 0) + n;
  return { ...prev, [step]: cur };
}

/** 운영자에게 보내는 하루 보고 (평문, 숫자만). 이메일·이름·id 없음. 운영자용이라 한국어만 쓴다. */
export function reportText(date: string, stats: DayStats, counts: MaintCounts): { subject: string; text: string } {
  const line = (o: Record<string, number>) => Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join(' ') || '-';
  const steps = STEP_NAMES.map((s) => `  ${s}: ${stats[s] ? line(stats[s]!) : '실행 없음'}`).join('\n');
  const failed = STEP_NAMES.reduce((n, s) => n + (stats[s]?.failed ?? 0), 0);
  return {
    subject: `[Recruit] 정리 작업 보고 ${date} (UTC)${failed ? ` — 실패 ${failed}회` : ''}`,
    text: [
      `정리 작업 보고: ${date} (UTC 0시~24시)`,
      '',
      '단계별 처리 수',
      steps,
      '',
      '지금 개수',
      `  회원(탈퇴 제외): ${line(counts.usersByRole)}`,
      `  게재 중 공고: ${counts.publishedJobs}`,
      `  지원(상태별): ${line(counts.applicationsByStatus)}`,
      '',
      '이 메일에는 개수만 들어 있습니다. 실패가 있으면 Cloudflare 대시보드의 Worker 로그에서 "maint:" 줄을 확인하세요.',
    ].join('\n'),
  };
}

/** 개발용: `wrangler dev` 에서 cron 문자열 "maint:<단계>" 로 단계를 골라 실행한다. APP_ENV 가 dev 일 때만 호출부가 쓴다. */
export function devForcedStep(cron: string | undefined): StepName | undefined {
  const m = /^maint:([A-Za-z]+)$/.exec((cron ?? '').trim());
  return m && (STEP_NAMES as readonly string[]).includes(m[1]!) ? (m[1] as StepName) : undefined;
}

// ───────── 단계

const tr = (l: 'ko' | 'zh', key: string) => t(l, key);

/** 1. 공고 자동 마감 + 3일 전 안내. 게재(publish)는 하지 않는다. 초안·차단 공고는 건드리지 않는다. */
export async function closeJobs(env: Env, now: number): Promise<StepResult> {
  const closedDeadline = await closeJobsPastDeadline(env.DB, { now, limit: CAPS.closeJobs });
  const closedStale = closedDeadline < CAPS.closeJobs
    ? await closeStaleJobs(env.DB, {
      now, staleBefore: now - JOB_STALE_AFTER, noticeBefore: now - JOB_CLOSE_NOTICE_BEFORE, limit: CAPS.closeJobs - closedDeadline,
    })
    : 0;
  const jobs = await listJobsNeedingCloseNotice(env.DB, {
    now, deadlineBefore: now + JOB_CLOSE_NOTICE_BEFORE, staleBefore: now - (JOB_STALE_AFTER - JOB_CLOSE_NOTICE_BEFORE), limit: CAPS.closeNoticeJobs,
  });
  let mailsSent = 0, mailsFailed = 0, noticed = 0;
  if (jobs.length) {
    const emails = new Map<string, string[]>();
    for (const r of await listActiveMemberEmails(env.DB, [...new Set(jobs.map((j) => j.company_id))])) {
      emails.set(r.company_id, [...(emails.get(r.company_id) ?? []), r.email]);
    }
    const plan = planNotices(jobs, emails, CAPS.closeNoticeMails);
    for (const p of plan) {
      const m = jobCloseNoticeMail(p.job, now, env.APP_ORIGIN, tr);
      for (const to of p.to) {
        // sendMail 은 실패해도 예외를 던지지 않는다 (email_log 에 결과가 남는다).
        if (await sendMail(env, { to, template: 'job_close_notice', ...m })) mailsSent++;
        else mailsFailed++;
      }
    }
    // 보낸 뒤에 표시한다 (보내기 전에 끊기면 다음 차례에 다시 보낸다 — 두 번 갈 수는 있어도 안 가는 일은 없게).
    noticed = await markCloseNoticeSent(env.DB, { now, jobs: plan.map((p) => ({ id: p.job.id, updated_at: p.job.updated_at })) });
  }
  return { step: 'closeJobs', done: { closed_deadline: closedDeadline, closed_stale: closedStale, noticed, mails_sent: mailsSent, mails_failed: mailsFailed } };
}

/** 2. 마감·차단된 공고의 지원에 보관 기한을 붙이고, 마감 확인 후 30일이 지난 진행 중 지원을 자동 종료한다. */
export async function markApplications(env: Env, now: number): Promise<StepResult> {
  // 차단이 풀려 다시 열린 공고의 진행 중 지원은 기한을 뗀다 (먼저 — 같은 실행에서 자동 종료되지 않게).
  const unmarked = await unmarkPurgeAfter(env.DB, { now, openStatuses: AUTO_CLOSABLE, limit: CAPS.markApplications });
  const marked = await markPurgeAfter(env.DB, { now, purgeAt: now + APPLICATION_KEEP_AFTER_CLOSE, limit: CAPS.markApplications });
  // purge_after - 180일 + 30일 < now  ⇔  purge_after < now + 180일 - 30일
  const purgeBefore = now + APPLICATION_KEEP_AFTER_CLOSE - APPLICATION_AUTO_CLOSE_AFTER;
  const rows = await listAutoCloseCandidates(env.DB, { purgeBefore, openStatuses: AUTO_CLOSABLE, limit: CAPS.markApplications });
  const r = await autoCloseApplications(env.DB, { groups: autoCloseGroups(rows), now, purgeBefore });
  return { step: 'markApplications', done: { marked, unmarked, auto_closed: r.changed, events: r.events } };
}

/** 3. 보관 기한이 지난 지원서의 내용을 지운다: D1 먼저(복사본·파일 키·요약 + 진행 중이면 auto_closed + 국외 이전 동의 철회), 그다음 R2 파일. */
export async function purgeApplications(env: Env, now: number): Promise<StepResult> {
  const rows = await listPurgeCandidates(env.DB, { now, limit: CAPS.purgeApplications });
  if (!rows.length) return { step: 'purgeApplications', done: { erased: 0, auto_closed: 0, consents: 0, files_deleted: 0, files_failed: 0 } };
  const r = await erasePurgedApplications(env.DB, { ids: rows.map((x) => x.id), groups: autoCloseGroups(rows), now });
  const keys = rows.map((x) => x.file_r2_key).filter((k): k is string => !!k && k.startsWith(ORPHAN_PREFIX));
  // 지운 뒤에도 어떤 행이 그 키를 가리키면(지워지지 않은 행) 파일을 지우지 않는다. 확인이 실패하면 예외 → 파일은 고아 정리가 나중에 치운다.
  const still = keys.length ? await findReferencedFileKeys(env.DB, keys) : new Set<string>();
  let filesDeleted = 0, filesFailed = 0;
  for (const k of keys) {
    if (still.has(k)) continue;
    try {
      await deleteResumeFile(env, k);
      filesDeleted++;
    } catch {
      filesFailed++; // 남은 객체는 sweepOrphans 가 24시간 뒤에 치운다
    }
  }
  return { step: 'purgeApplications', done: { erased: r.erased, auto_closed: r.changed, consents: r.consents, files_deleted: filesDeleted, files_failed: filesFailed } };
}

/** 4. 보관 기간이 지난 행을 지운다 (표마다 200행까지). users 행은 지우지 않는다. */
export async function dropOldRowsStep(env: Env, now: number): Promise<StepResult> {
  const r = await dropOldRows(env.DB, {
    now, erasedBefore: now - ERASED_ROW_KEEP, accessBefore: now - ACCESS_LOG_KEEP, emailBefore: now - EMAIL_LOG_KEEP,
    usageBefore: kstDay(now - USAGE_KEEP_DAYS * DAY), limit: CAPS.dropRowsPerTable,
  });
  return { step: 'dropOldRows', done: { ...r } };
}

/** 5. 확인 후 1년이 지난 사업자 서류: D1 행을 먼저 지우고 그다음 R2 객체(vdocs/ 아래만). 확인 대기 서류는 건드리지 않는다. */
export async function purgeVerificationDocs(env: Env, now: number): Promise<StepResult> {
  const reviewedBefore = now - VDOC_KEEP_AFTER_REVIEW;
  const rows = (await listExpiredVerificationDocs(env.DB, { reviewedBefore, limit: CAPS.purgeVerificationDocs }))
    .filter((d) => d.r2_key.startsWith(VDOC_PREFIX));
  const deleted = await deleteVerificationDocRows(env.DB, { ids: rows.map((d) => d.id), reviewedBefore });
  let rowsDeleted = 0, filesDeleted = 0, filesFailed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!deleted[i]) continue;
    rowsDeleted++;
    try {
      await env.FILES.delete(rows[i]!.r2_key);
      filesDeleted++;
    } catch {
      filesFailed++; // vdocs/ 아래 남은 객체는 자동으로 치우지 않는다 (docs/TASKS.md 남은 일)
    }
  }
  return { step: 'purgeVerificationDocs', done: { rows_deleted: rowsDeleted, files_deleted: filesDeleted, files_failed: filesFailed } };
}

/**
 * 6. R2 rfiles/ 의 고아 객체: 목록 한 쪽(100개, 커서는 site_settings 'maint.rfiles_cursor')에서 24시간이 지났고 어느 행도 가리키지 않는 객체를 10개까지 지운다.
 * 참조 확인이 실패하면(예외) 아무것도 지우지 않는다. 지울 것이 10개를 넘으면 커서를 옮기지 않아 다음 차례에 같은 쪽을 다시 본다.
 */
export async function sweepOrphans(env: Env, now: number): Promise<StepResult> {
  const cursor = await getSetting(env.DB, ORPHAN_CURSOR_KEY);
  let page: R2Objects;
  try {
    page = await env.FILES.list({ prefix: ORPHAN_PREFIX, limit: CAPS.orphanListPage, ...(cursor ? { cursor } : {}) });
  } catch (e) {
    // 저장해 둔 커서가 더는 쓸 수 없으면 매번 같은 곳에서 멈추므로 지우고 다음 차례에 처음부터 본다 (아무것도 지우지 않았다).
    if (cursor) await deleteMaintSetting(env.DB, ORPHAN_CURSOR_KEY, now);
    throw e;
  }
  const objects: R2ListedObject[] = page.objects.map((o) => ({ key: o.key, uploaded: o.uploaded }));
  const old = objects.filter((o) => o.key.startsWith(ORPHAN_PREFIX) && isOldEnough(o, now));
  const referenced = new Set<string>();
  for (const part of chunk(old.map((o) => o.key), CAPS.refCheckChunk)) {
    for (const k of await findReferencedFileKeys(env.DB, part)) referenced.add(k); // 예외는 그대로 올린다 → 아무것도 지우지 않음
  }
  const allOrphans = pickOrphans(old, referenced, now, Number.MAX_SAFE_INTEGER);
  const toDelete = allOrphans.slice(0, CAPS.orphanDeletes);
  let deleted = 0, failed = 0;
  for (const k of toDelete) {
    try {
      await deleteResumeFile(env, k);
      deleted++;
    } catch {
      failed++;
    }
  }
  const capped = allOrphans.length > toDelete.length;
  let cursorMoved = 0;
  if (!capped && !failed) {
    const next = page.truncated ? (page as { cursor?: string }).cursor : undefined;
    if (next) {
      await putMaintSetting(env.DB, ORPHAN_CURSOR_KEY, next, now);
      cursorMoved = 1;
    } else if (cursor) {
      await deleteMaintSetting(env.DB, ORPHAN_CURSOR_KEY, now);
    }
  }
  return {
    step: 'sweepOrphans',
    done: { listed: objects.length, young: objects.length - old.length, referenced: referenced.size, deleted, failed, cursor_moved: cursorMoved, listing_done: page.truncated ? 0 : 1 },
  };
}

/** 7. 하루 보고 (REPORT_HOUR_UTC 에 한 번): 전날(UTC) 집계 + 지금 개수를 OPS_EMAIL 로. 없으면 메일 없이 넘어간다. 오래된 집계 줄을 지운다. */
export async function report(env: Env, now: number): Promise<StepResult> {
  const yesterday = now - DAY;
  let sent = 0;
  const to = (env.OPS_EMAIL ?? '').trim();
  if (to) {
    const stats = parseStats(await getSetting(env.DB, statsKey(yesterday)));
    const counts = await maintenanceCounts(env.DB);
    const m = reportText(utcDate(yesterday), stats, counts);
    if (await sendMail(env, { to, template: 'ops_report', ...m })) sent = 1;
  }
  const oldStats = await deleteOldMaintStats(env.DB, {
    beforeKey: statsKey(now - CAPS.statsKeepDays * DAY), updatedBefore: now - CAPS.statsKeepDays * DAY + DAY, limit: 20,
  });
  return { step: 'report', done: { mail_sent: sent, mail_skipped: to ? 0 : 1, old_stats_deleted: oldStats } };
}

export const STEPS: Record<StepName, StepFn> = {
  closeJobs, markApplications, purgeApplications, dropOldRows: dropOldRowsStep, purgeVerificationDocs, sweepOrphans, report,
};

// ───────── 실행

export interface RunOptions {
  /** 이 단계를 실행한다 (시간표 대신). 테스트와, APP_ENV=dev 일 때의 wrangler 수동 실행(src/index.tsx)만 넘긴다. */
  force?: StepName;
  /** 테스트용 단계 구현 바꾸기. */
  impl?: Partial<Record<StepName, StepFn>>;
}

export interface RunOutcome { step: StepName; ok: boolean; done: Record<string, number> }

/** 예약 작업 한 번: 단계 하나 → 집계 기록 → 로그 한 줄. 예외를 밖으로 내보내지 않는다. */
export async function runMaintenance(env: Env, nowSec: number, opts: RunOptions = {}): Promise<RunOutcome> {
  const step = opts.force ?? stepForTime(nowSec);
  const fn = opts.impl?.[step] ?? STEPS[step];
  let ok = true;
  let done: Record<string, number> = {};
  try {
    done = (await fn(env, nowSec)).done;
  } catch {
    ok = false; // 오류 내용은 남기지 않는다 (키·주소가 들어 있을 수 있다)
  }
  const numbers = Object.fromEntries(Object.entries(done).filter(([, n]) => typeof n === 'number' && Number.isFinite(n)));
  try {
    const key = statsKey(nowSec);
    await putMaintSetting(env.DB, key, JSON.stringify(mergeStats(parseStats(await getSetting(env.DB, key)), step, ok, numbers)), nowSec);
  } catch {
    /* 집계를 못 남겨도 작업 결과는 그대로다 */
  }
  console.log(`maint: step=${step} ${ok ? 'ok' : 'failed'} counts=${JSON.stringify(numbers)}`);
  return { step, ok, done: numbers };
}
