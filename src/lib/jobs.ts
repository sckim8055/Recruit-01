// 공고 작성 폼의 검사와 정규화, 저장할 때의 상태 계산, 숫자 대조 경고. 순수 함수만 둔다 (DB·네트워크 접근 없음)
// — test/jobs.test.ts 로 검증한다. 게재 가능 여부 자체는 rules.publishBlocks 만 정한다 (CLAUDE.md 규칙 2).
//
// 저장 방식
// - 중국어 원문: 제목 title_zh(한 줄) + 본문 source_zh. 이 두 칸만 현지화 엔진으로 보낸다.
// - 연봉·근무시간·근무지 등은 선택형·숫자 입력이며 번역하지 않는다. 공개 화면은 이 값을 그대로 쓴다.
// - 한국어 초안(title_ko·body_ko)을 기업이 직접 고치면 대조본(back_zh)은 지운다 (고친 글의 대조본이 아니므로).
import type { Flags } from '../env';
import type { OptionKind } from './options';
import { contactEmailProblem, techLeakFlag, type PublishInput } from './rules';

export const JOB_LIMITS = { title: 120, body: 8000, reason: 500 } as const;
export const SALARY_MAX = 100_000; // 만원/년 (10억)

// 직무(role_category)·업계(industry)·근무지(location)의 선택 항목은 DB(job_options)에 있다 (T-06e, lib/options.ts).
// 아래는 관리하지 않는 고정 목록이다.
export const SALARY_BASES = ['severance_excluded', 'severance_included'] as const;
export const REPORT_LINES = ['kr_head', 'cn_hq'] as const;
export const CHINESE_LEVELS = ['none', 'basic', 'business', 'native'] as const;
export const JOB_FAMILIES = ['office', 'production'] as const;

export type JobStatus = 'draft' | 'published' | 'closed' | 'blocked';
export type LocalizeStatus = 'draft' | 'review' | 'approved';
export type JobFamily = (typeof JOB_FAMILIES)[number];

/** 기업이 폼으로 입력하는 값 (저장 형태). */
export interface JobFields {
  title_zh: string;
  source_zh: string;
  job_family: JobFamily;
  role_category: string | null;
  industry: string | null;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_basis: string | null;
  work_hours: string | null;      // "HH:MM-HH:MM"
  report_line: string | null;
  chinese_level: string | null;
  contact_email: string | null;
  closes_at: number | null;       // 마감일 23:59:59 (한국 시간)
}

export const JOB_FORM_FIELDS = [
  'title_zh', 'source_zh', 'job_family', 'role_category', 'industry', 'location', 'salary_min', 'salary_max',
  'salary_basis', 'work_start', 'work_end', 'report_line', 'chinese_level', 'contact_email', 'closes_at',
] as const;
export type JobFormField = (typeof JOB_FORM_FIELDS)[number];
export type JobInput = Record<JobFormField, string>;

export interface JobFieldError {
  field: JobFormField | 'title_ko' | 'body_ko';
  code: 'required' | 'too_long' | 'invalid' | 'range' | 'contact_in_text' | 'operator_email' | 'past';
}

const str = (f: Record<string, unknown>, k: string): string => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
const text = (f: Record<string, unknown>, k: string): string => str(f, k).replace(/\r\n?/g, '\n');
const isOneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

export function readJobForm(f: Record<string, unknown>): JobInput {
  const out = {} as JobInput;
  for (const k of JOB_FORM_FIELDS) out[k] = k === 'source_zh' ? text(f, k) : str(f, k);
  // 제목은 한 줄
  out.title_zh = out.title_zh.replace(/\s*\n\s*/g, ' ');
  return out;
}

/** 저장된 값을 폼 값 모양으로 (편집 화면의 기본값). */
export function inputFromJob(j: JobFields): JobInput {
  const [ws, we] = (j.work_hours ?? '').split('-');
  return {
    title_zh: j.title_zh, source_zh: j.source_zh, job_family: j.job_family,
    role_category: j.role_category ?? '', industry: j.industry ?? '', location: j.location ?? '',
    salary_min: j.salary_min == null ? '' : String(j.salary_min), salary_max: j.salary_max == null ? '' : String(j.salary_max),
    salary_basis: j.salary_basis ?? '', work_start: ws ?? '', work_end: we ?? '',
    report_line: j.report_line ?? '', chinese_level: j.chinese_level ?? '', contact_email: j.contact_email ?? '',
    closes_at: j.closes_at == null ? '' : kstDate(j.closes_at),
  };
}

export const EMPTY_JOB_INPUT: JobInput = Object.fromEntries(JOB_FORM_FIELDS.map((k) => [k, k === 'job_family' ? 'office' : ''])) as JobInput;

// ── 원문 안의 연락처: 엔진에 개인정보·연락처가 가지 않도록, 연락처는 연락처 칸에만 적게 한다.
const EMAIL_IN_TEXT = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
// 한국 휴대폰·일반전화, 중국 휴대폰, +82/+86 국제번호. 연봉 범위(5000-6000) 같은 숫자는 걸리지 않게 한다.
const PHONE_IN_TEXT = /(\+\s?8[26][\s-]?\d{1,4}[\s-]?\d{3,4}[\s-]?\d{4})|(\b0\d{1,2}[\s-]\d{3,4}[\s-]\d{4}\b)|(\b01[016789]-?\d{3,4}-?\d{4}\b)|(\b1[3-9]\d{9}\b)/;

export function hasContactInText(s: string): boolean {
  return EMAIL_IN_TEXT.test(s) || PHONE_IN_TEXT.test(s);
}

// ── 날짜 (한국 시간)
const KST = 9 * 3600;
export const kstDate = (ts: number): string => new Date((ts + KST) * 1000).toISOString().slice(0, 10);

/** "YYYY-MM-DD" → 그날 23:59:59 (한국 시간). 형식이 틀리면 null. */
export function parseKstDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return null;
  return ms / 1000 + 86399 - KST;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const INT_RE = /^\d{1,6}$/;

export type JobCheck = { ok: true; value: JobFields } | { ok: false; errors: JobFieldError[] };

/**
 * 공고 폼 검사. 통과하면 저장할 값을 돌려준다. 초안 저장 단계의 검사이며, 게재 조건(publishBlocks)을 대신하지 않는다.
 * - 생산직(production)은 FLAG_PRODUCTION_JOBS 가 켜져 있을 때만 받는다 (꺼져 있으면 폼에 선택 칸도 없다)
 * - 연봉: 정수(만원/년). 최대만 적을 수는 없다. 연봉을 적으면 퇴직금 포함/별도가 필수
 * - 연락처: 비워 둘 수 있지만(게재 때 막힘), 적으면 형식이 맞고 운영자 도메인이 아니어야 한다
 * - 직무·업계·근무지: 비워 둘 수 있다. 적으면 ctx.options 의 목록 안의 값이어야 한다. 호출부는 화면에 보인 목록과 같은 것
 *   (lib/options.selectableAll: 사용 중인 항목 + 편집하는 공고에 지금 저장된 값)을 넘긴다 — 사용 종료된 값은 원래 그 값일 때만 통과한다
 */
export function validateJob(
  i: JobInput,
  ctx: { flags: Flags; operatorDomains: string[]; now: number; options: Readonly<Record<OptionKind, readonly string[]>> },
): JobCheck {
  const errors: JobFieldError[] = [];
  const err = (field: JobFieldError['field'], code: JobFieldError['code']) => errors.push({ field, code });

  if (!i.title_zh) err('title_zh', 'required');
  else if (i.title_zh.length > JOB_LIMITS.title) err('title_zh', 'too_long');
  if (!i.source_zh) err('source_zh', 'required');
  else if (i.source_zh.length > JOB_LIMITS.body) err('source_zh', 'too_long');
  if (hasContactInText(i.title_zh)) err('title_zh', 'contact_in_text');
  if (hasContactInText(i.source_zh)) err('source_zh', 'contact_in_text');

  const family: JobFamily | null = i.job_family === '' || i.job_family === 'office' ? 'office'
    : i.job_family === 'production' && ctx.flags.productionJobs ? 'production' : null;
  if (!family) err('job_family', 'invalid');

  const choice = (field: JobFormField, list: readonly string[]): string | null => {
    const v = i[field];
    if (v === '') return null;
    if (!isOneOf(list, v)) { err(field, 'invalid'); return null; }
    return v;
  };
  const role_category = choice('role_category', ctx.options.role_category);
  const industry = choice('industry', ctx.options.industry);
  const location = choice('location', ctx.options.location);
  const salary_basis = choice('salary_basis', SALARY_BASES);
  const report_line = choice('report_line', REPORT_LINES);
  const chinese_level = choice('chinese_level', CHINESE_LEVELS);

  const num = (field: 'salary_min' | 'salary_max'): number | null => {
    const v = i[field].replace(/,/g, '');
    if (v === '') return null;
    if (!INT_RE.test(v)) { err(field, 'invalid'); return null; }
    const n = Number(v);
    if (n < 1 || n > SALARY_MAX) { err(field, 'range'); return null; }
    return n;
  };
  const salary_min = num('salary_min');
  const salary_max = num('salary_max');
  if (salary_max != null && salary_min == null && i.salary_min === '') err('salary_min', 'required');
  if (salary_min != null && salary_max != null && salary_max < salary_min) err('salary_max', 'range');
  if ((salary_min != null || salary_max != null) && !salary_basis && i.salary_basis === '') err('salary_basis', 'required');

  let work_hours: string | null = null;
  if (i.work_start || i.work_end) {
    const okS = TIME_RE.test(i.work_start), okE = TIME_RE.test(i.work_end);
    if (!okS) err('work_start', i.work_start ? 'invalid' : 'required');
    if (!okE) err('work_end', i.work_end ? 'invalid' : 'required');
    if (okS && okE) {
      if (i.work_start === i.work_end) err('work_end', 'invalid');
      else work_hours = `${i.work_start}-${i.work_end}`;
    }
  }

  let contact_email: string | null = null;
  if (i.contact_email) {
    const e = i.contact_email.toLowerCase();
    const p = contactEmailProblem(e, ctx.operatorDomains);
    if (p === 'contact_is_operator') err('contact_email', 'operator_email');
    else if (p || e.length > 254) err('contact_email', 'invalid');
    else contact_email = e;
  }

  let closes_at: number | null = null;
  if (i.closes_at) {
    const ts = parseKstDate(i.closes_at);
    if (ts == null) err('closes_at', 'invalid');
    else if (ts < ctx.now) err('closes_at', 'past');
    else if (ts > ctx.now + 366 * 86400) err('closes_at', 'range');
    else closes_at = ts;
  }

  if (errors.length || !family) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title_zh: i.title_zh, source_zh: i.source_zh, job_family: family, role_category, industry, location,
      salary_min, salary_max, salary_basis, work_hours, report_line, chinese_level, contact_email, closes_at,
    },
  };
}

export type KoreanCheck = { ok: true; title_ko: string; body_ko: string } | { ok: false; errors: JobFieldError[] };

/** 기업이 한국어 초안을 직접 입력·수정할 때. */
export function readKoreanForm(f: Record<string, unknown>): KoreanCheck {
  const title_ko = str(f, 'title_ko').replace(/\s*\n\s*/g, ' ');
  const body_ko = text(f, 'body_ko');
  const errors: JobFieldError[] = [];
  if (!title_ko) errors.push({ field: 'title_ko', code: 'required' });
  else if (title_ko.length > JOB_LIMITS.title) errors.push({ field: 'title_ko', code: 'too_long' });
  if (!body_ko) errors.push({ field: 'body_ko', code: 'required' });
  else if (body_ko.length > JOB_LIMITS.body) errors.push({ field: 'body_ko', code: 'too_long' });
  return errors.length ? { ok: false, errors } : { ok: true, title_ko, body_ko };
}

// ── 저장할 때의 상태 계산

export interface JobText {
  title_zh: string | null;
  source_zh: string | null;
  title_ko: string | null;
  body_ko: string | null;
}
export interface JobState extends JobText {
  status: JobStatus;
  localize_status: LocalizeStatus;
  review_flag: string | null;
  review_cleared_by: string | null;
}

/** 기술유출 필터에 넣는 글: 기업이 쓴 글 전부 (원문·한국어 초안). */
export const flagText = (t: JobText): string => [t.title_zh, t.source_zh, t.title_ko, t.body_ko].map((s) => s ?? '').join('\n');

export const textChanged = (a: JobText, b: JobText): boolean =>
  a.title_zh !== b.title_zh || a.source_zh !== b.source_zh || a.title_ko !== b.title_ko || a.body_ko !== b.body_ko;

export interface SavePlan {
  status: JobStatus;
  localize_status: LocalizeStatus;
  review_flag: string | null;
  review_cleared_by: string | null;
  /** 게재 중이던 공고가 게재 중단(draft)된다. */
  unpublished: boolean;
}

/**
 * 기업이 공고를 저장할 때(원문·구조 항목 수정, 현지화 초안 생성, 한국어 직접 수정) 결과 상태를 정한다.
 * - 기술유출 필터: 저장할 때마다 다시 계산한다. 걸린 글이 바뀌었으면 관리자 검토 통과를 지운다
 * - 원문·한국어 중 하나라도 바뀌면: 한국어 초안이 있으면 'review'(다시 확인), 없으면 'draft'.
 *   게재 중이면 게재 중단(draft) — 기업이 다시 확인·승인한 뒤 게재해야 한다
 * - 글은 그대로이고 구조 항목만 바뀌었으면: 게재 중인 공고는 stillPublishable(바뀐 값으로 계산한 publishBlocks 가 빈 배열)일 때만 유지
 * - 마감(closed)·차단(blocked) 상태는 바꾸지 않는다 (마감된 공고는 호출부가 저장을 막는다)
 */
export function planJobSave(cur: JobState, next: JobText, stillPublishable: (review: { review_flag: string | null; review_cleared_by: string | null }) => boolean): SavePlan {
  const review = reviewAfterSave(cur, next);
  const changed = textChanged(cur, next);
  const hasKo = !!(next.title_ko?.trim() && next.body_ko?.trim());
  const localize_status: LocalizeStatus = changed ? (hasKo ? 'review' : 'draft') : hasKo ? cur.localize_status : 'draft';
  let status = cur.status;
  if (cur.status === 'published' && (changed || !stillPublishable(review))) status = 'draft';
  return { status, localize_status, ...review, unpublished: cur.status === 'published' && status !== 'published' };
}

/** 기술유출 필터 결과와 관리자 검토 통과 여부. */
export function reviewAfterSave(
  cur: JobText & { review_cleared_by: string | null },
  next: JobText,
): { review_flag: string | null; review_cleared_by: string | null } {
  const review_flag = techLeakFlag(flagText(next));
  if (review_flag === null) return { review_flag, review_cleared_by: null };
  const same = flagText(cur) === flagText(next);
  return { review_flag, review_cleared_by: same ? cur.review_cleared_by : null };
}

// ── 게재 판단 입력

export interface JobRowForPublish {
  job_family: JobFamily;
  title_ko: string | null;
  body_ko: string | null;
  localize_status: LocalizeStatus;
  contact_email: string | null;
  salary_basis: string | null;
  salary_min: number | null;
  agency_id: string | null;
  review_flag: string | null;
  review_cleared_by: string | null;
}

/** DB 행·기업·환경으로 publishBlocks 의 입력을 만든다. 판단은 publishBlocks 가 한다. */
export function publishInputOf(
  job: JobRowForPublish,
  ctx: { companyVerified: boolean; flags: Flags; appEnv: PublishInput['appEnv']; registrationNo: string; operatorDomains: string[] },
): PublishInput {
  return {
    job: {
      job_family: job.job_family, title_ko: job.title_ko, body_ko: job.body_ko, localize_status: job.localize_status,
      contact_email: job.contact_email, salary_basis: job.salary_basis, salary_min: job.salary_min,
      agency_id: job.agency_id, review_flag: job.review_flag, review_cleared_by: job.review_cleared_by,
    },
    companyVerified: ctx.companyVerified,
    // 기업 화면에서는 헤드헌터 공고를 만들지 않는다 (T-15). agency_id 가 있으면 publishBlocks 가 막는다.
    agencyVerified: false,
    flags: ctx.flags,
    appEnv: ctx.appEnv,
    registrationNo: ctx.registrationNo,
    operatorDomains: ctx.operatorDomains,
  };
}

// ── 숫자 대조 (경고만. 게재 조건이 아니다)

/** 전각 숫자를 반각으로 바꾸고, 숫자 사이의 쉼표(5,000)를 없앤 뒤 숫자 묶음을 순서대로 뽑는다. */
export function digitRuns(s: string): string[] {
  const half = s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/(\d)[,，](?=\d{3}\b)/g, '$1');
  return half.match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * 중국어 원문과 한국어 초안의 숫자 묶음을 비교한다 (순서 무관, 개수까지).
 * missing: 원문에 있는데 한국어에 없는 숫자, extra: 한국어에만 있는 숫자. 둘 다 비면 같다.
 * 원문이 "五年" 처럼 한자 숫자를 쓰면 한국어 "5년" 이 extra 로 잡힌다 — 그래서 경고로만 쓴다.
 */
export function digitDiff(zh: string, ko: string): { missing: string[]; extra: string[] } {
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const a = count(digitRuns(zh)), b = count(digitRuns(ko));
  const missing: string[] = [], extra: string[] = [];
  for (const [k, n] of a) for (let i = b.get(k) ?? 0; i < n; i++) missing.push(k);
  for (const [k, n] of b) for (let i = a.get(k) ?? 0; i < n; i++) extra.push(k);
  return { missing, extra };
}

// ── 관리자 차단 사유

export type BlockReason = { ok: true; reason: string } | { ok: false; why: 'reason_required' | 'reason_too_long' };

export function readBlockReason(f: Record<string, unknown>): BlockReason {
  const reason = text(f, 'reason');
  if (!reason) return { ok: false, why: 'reason_required' };
  if (reason.length > JOB_LIMITS.reason) return { ok: false, why: 'reason_too_long' };
  return { ok: true, reason };
}

/** 숨김 칸으로 받은 내용 버전(rev). 정수가 아니면 null. */
export function readRev(f: Record<string, unknown>): number | null {
  const v = str(f, 'rev');
  return /^\d{1,9}$/.test(v) ? Number(v) : null;
}
