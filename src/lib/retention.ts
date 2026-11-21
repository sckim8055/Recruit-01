// 보관 기간과 예약 작업의 기간 (T-12, T-12c). 이 파일 한 곳에만 둔다. 순수 함수 — test/retention.test.ts · test/maintenance.test.ts.
//
// T-12c: 아래 다섯 기간은 관리자가 /admin/settings 에서 정한 범위 안에서 바꿀 수 있다 (site_settings 의 'retention' 한 줄, JSON).
// 행이 없으면 기본값(= T-12 의 상수와 같은 숫자)을 쓴다.
//
// ★ 운영자와 정한 법적 원칙 (docs/ARCHITECTURE.md 14-1):
//   - 개인정보(지원서·첨부·사업자 서류·열람 기록)는 기간이 끝나면 **반드시 지운다.** "영구 보관"·"지우지 않고 비활성화" 같은 선택은 없다.
//     그래서 개인정보 기간에는 0(끄기)이 없고 위아래 한도가 있다.
//   - 개인정보가 아닌 것만 끌 수 있다: 마감일 없는 공고의 자동 마감(job_stale_days = 0).
//   - 개인정보처리방침·동의 문구는 항상 지금 적용되는 숫자를 보인다 (src/legal/render.ts 가 이 값으로 채운다).
//   - 늘린 기간은 이미 낸 지원서에 소급하지 않는다: 지원서마다 낼 때의 기간(applications.keep_days)을 저장하고, 실제 기간은
//     MIN(낼 때의 기간, 지금 기간). 줄이면 모두에게 적용(더 일찍 지움), 늘리면 그 뒤에 낸 지원서에만 적용.
//   - 개인정보 기간을 하나라도 늘리면 rev 가 1 오르고 개인정보처리방침 판이 바뀌어 회원에게 다시 동의를 받는다 (lib/consent.privacyVersion).
//
// 바꿀 수 없는 기간(상수 그대로): 내용 없는 행·철회된 동의 2년, 메일 기록 1년, 고아 객체 24시간, 마감 안내 3일 전, 하루 사용량(lib/quota).
// 단위: *_days 는 일, 그 밖의 상수는 초.

export const DAY = 86_400;
export const HOUR = 3_600;

/** 지원서 내용(복사본·첨부)의 **기본** 보관 기간: 공고 마감(을 확인한 때)부터 180일. 설정 application_keep_days 의 기본값. */
export const APPLICATION_KEEP_AFTER_CLOSE = 180 * DAY;
/** 기본값: 공고 마감(을 확인한 때)부터 30일이 지나도 진행 중인 지원은 'auto_closed' (상태 "채용 종료"). 설정 application_auto_close_days. */
export const APPLICATION_AUTO_CLOSE_AFTER = 30 * DAY;
/** 기본값: 확인(승인·반려)이 끝난 사업자 서류는 확인 후 1년 뒤 삭제. 설정 vdoc_keep_days. */
export const VDOC_KEEP_AFTER_REVIEW = 365 * DAY;
/** 기본값: 열람 기록(access_log) 2년. 설정 access_log_keep_days. */
export const ACCESS_LOG_KEEP = 730 * DAY;
/** 내용을 지운 지원 행·이벤트, 철회된 동의 기록: 2년 뒤 행 삭제 (바꿀 수 없음). 방침 3항 "동의 기록, 지원했다는 사실 … 2년". */
export const ERASED_ROW_KEEP = 730 * DAY;
/** 메일 발송 기록(email_log, 주소 해시·템플릿·결과): 1년 (바꿀 수 없음). */
export const EMAIL_LOG_KEEP = 365 * DAY;
/** 기본값: 마감일 없는 게재 중 공고는 마지막 저장 후 30일이면 자동 마감. 설정 job_stale_days (0 = 끔). */
export const JOB_STALE_AFTER = 30 * DAY;
/** 자동 마감 3일 전에 기업 담당자에게 안내 메일 (바꿀 수 없음). */
export const JOB_CLOSE_NOTICE_BEFORE = 3 * DAY;
/** R2 고아 객체: 올라온 지 24시간이 지난 것만 지운다 (바꿀 수 없음). */
export const ORPHAN_MIN_AGE = 24 * HOUR;

// ───────── 관리자가 바꾸는 기간 (T-12c)

/** site_settings 키. 값은 JSON 한 줄 (RetentionSettings). */
export const RETENTION_SETTING = 'retention';
/** site_settings 키. 바꾼 기록(최근 20줄, id·숫자만)의 JSON 배열. */
export const RETENTION_LOG_SETTING = 'retention.log';
export const RETENTION_LOG_MAX = 20;
/**
 * applications.keep_days 가 NULL 인 지원(0011 이전에 낸 지원)의 기간. T-12c 이전에 개인정보처리방침이 약속한 숫자.
 * 기본값이 바뀌어도 이 값은 바꾸지 않는다 (예전 지원의 약속).
 */
export const LEGACY_APPLICATION_KEEP_DAYS = 180;

export type RetentionKey =
  | 'application_keep_days' | 'application_auto_close_days' | 'vdoc_keep_days' | 'access_log_keep_days' | 'job_stale_days';

export interface RetentionSpecItem {
  key: RetentionKey;
  default: number;
  min: number;
  max: number;
  unit: 'day';
  /** 0 = 끄기를 받는가 (개인정보가 아닌 것만). */
  offAllowed: boolean;
  /** 개인정보 보관 기간인가 — 늘리면 다시 동의를 받는다. */
  personal: boolean;
}

/** 바꿀 수 있는 기간의 목록 (화면 순서). 범위 밖·정수 아닌 값은 받지 않는다. */
export const RETENTION_SPEC: readonly RetentionSpecItem[] = [
  { key: 'application_keep_days', default: 180, min: 30, max: 365, unit: 'day', offAllowed: false, personal: true },
  { key: 'application_auto_close_days', default: 30, min: 7, max: 90, unit: 'day', offAllowed: false, personal: false },
  { key: 'vdoc_keep_days', default: 365, min: 90, max: 1095, unit: 'day', offAllowed: false, personal: true },
  { key: 'access_log_keep_days', default: 730, min: 365, max: 1825, unit: 'day', offAllowed: false, personal: true },
  { key: 'job_stale_days', default: 30, min: 14, max: 180, unit: 'day', offAllowed: true, personal: false },
];

export const RETENTION_KEYS: readonly RetentionKey[] = RETENTION_SPEC.map((s) => s.key);
const SPEC = Object.fromEntries(RETENTION_SPEC.map((s) => [s.key, s])) as Record<RetentionKey, RetentionSpecItem>;
export const specOf = (k: RetentionKey): RetentionSpecItem => SPEC[k];

export type RetentionValues = Record<RetentionKey, number>;
/** 저장되는 값: 다섯 기간 + rev(개인정보 기간을 늘린 횟수 — 개인정보처리방침 판에 붙는다). */
export interface RetentionSettings extends RetentionValues { rev: number }

export const DEFAULT_RETENTION: RetentionSettings = Object.freeze({
  ...(Object.fromEntries(RETENTION_SPEC.map((s) => [s.key, s.default])) as RetentionValues),
  rev: 0,
});

const REV_MAX = 1_000_000;

/** 그 칸에 받을 수 있는 값인가 (정수, 범위 안, 끄기를 받는 칸이면 0 도). */
export function inRange(k: RetentionKey, n: unknown): n is number {
  const s = SPEC[k];
  return typeof n === 'number' && Number.isInteger(n) && ((n >= s.min && n <= s.max) || (s.offAllowed && n === 0));
}

/**
 * 저장된 설정 해석. 행이 없거나 JSON 이 아니면 기본값. 칸마다 범위 밖·정수 아님·없음이면 **그 칸의 기본값**(한도 없는 값으로 가지 않는다).
 * 자동 종료가 보관 기간보다 짧지 않으면 min(기본값, 보관 기간 - 1) 로 줄인다 (보관 기간 최소 30 → 29 이상이라 자동 종료 최소 7 안).
 */
export function parseRetention(raw: string | null): RetentionSettings {
  let v: unknown = null;
  if (raw) {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out = { ...DEFAULT_RETENTION };
  for (const k of RETENTION_KEYS) if (inRange(k, o[k])) out[k] = o[k] as number;
  if (out.application_auto_close_days >= out.application_keep_days) {
    out.application_auto_close_days = Math.min(SPEC.application_auto_close_days.default, out.application_keep_days - 1);
  }
  out.rev = typeof o.rev === 'number' && Number.isInteger(o.rev) && o.rev >= 0 && o.rev <= REV_MAX ? o.rev : 0;
  return out;
}

export const serializeRetention = (r: RetentionSettings): string =>
  JSON.stringify({ ...Object.fromEntries(RETENTION_KEYS.map((k) => [k, r[k]])), rev: r.rev });

export type RetentionFieldError = 'not_integer' | 'out_of_range' | 'auto_close_not_shorter';
export type RetentionForm = Record<RetentionKey, string> & { job_stale_off: boolean };

/** 폼 값(문자열)을 그대로 돌려준다 — 오류로 다시 그릴 때 입력을 유지하려고. */
export function readRetentionForm(f: Record<string, unknown>): RetentionForm {
  const s = (x: unknown) => (typeof x === 'string' ? x.trim().slice(0, 10) : '');
  return {
    ...(Object.fromEntries(RETENTION_KEYS.map((k) => [k, s(f[k])])) as Record<RetentionKey, string>),
    job_stale_off: f.job_stale_off === '1' || f.job_stale_off === 'on',
  };
}

export const formFromRetention = (r: RetentionValues): RetentionForm => ({
  ...(Object.fromEntries(RETENTION_KEYS.map((k) => [k, k === 'job_stale_days' && r[k] === 0 ? '' : String(r[k])])) as Record<RetentionKey, string>),
  job_stale_off: r.job_stale_days === 0,
});

/**
 * 관리자 폼 검사. 칸마다 오류 하나. job_stale_off 가 체크되면 job_stale_days = 0 (칸 값은 보지 않는다), 칸에 0 을 써도 끄기.
 * 자동 종료 일수는 지원서 보관 일수보다 작아야 한다.
 */
export function validateRetentionForm(
  form: RetentionForm,
): { ok: true; value: RetentionValues } | { ok: false; errors: Partial<Record<RetentionKey, RetentionFieldError>> } {
  const errors: Partial<Record<RetentionKey, RetentionFieldError>> = {};
  const value = {} as RetentionValues;
  for (const k of RETENTION_KEYS) {
    if (k === 'job_stale_days' && form.job_stale_off) { value[k] = 0; continue; }
    const raw = form[k];
    if (!/^\d{1,6}$/.test(raw)) { errors[k] = 'not_integer'; continue; }
    const n = Number(raw);
    if (!inRange(k, n)) { errors[k] = 'out_of_range'; continue; }
    value[k] = n;
  }
  if (!errors.application_keep_days && !errors.application_auto_close_days
    && value.application_auto_close_days >= value.application_keep_days) {
    errors.application_auto_close_days = 'auto_close_not_shorter';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export interface RetentionChange { key: RetentionKey; from: number; to: number }

/** 저장 계획: 바뀐 칸(old → new), 늘어난·줄어든 개인정보 기간, 새 rev(개인정보 기간이 하나라도 늘면 +1). */
export function planRetentionSave(old: RetentionSettings, next: RetentionValues): {
  changes: RetentionChange[]; lengthened: RetentionKey[]; shortened: RetentionKey[]; reconsent: boolean; value: RetentionSettings;
} {
  const changes = RETENTION_KEYS.filter((k) => old[k] !== next[k]).map((k) => ({ key: k, from: old[k], to: next[k] }));
  const personal = changes.filter((c) => SPEC[c.key].personal);
  const lengthened = personal.filter((c) => c.to > c.from).map((c) => c.key);
  const shortened = personal.filter((c) => c.to < c.from).map((c) => c.key);
  const reconsent = lengthened.length > 0;
  return { changes, lengthened, shortened, reconsent, value: { ...next, rev: old.rev + (reconsent ? 1 : 0) } };
}

export interface RetentionLogEntry { at: number; by: string; changes: RetentionChange[] }

/** 바꾼 기록에 한 줄을 더한다 (최근 RETENTION_LOG_MAX 줄, id·숫자만). 저장된 값이 깨졌으면 새로 시작한다. */
export function appendRetentionLog(raw: string | null, entry: RetentionLogEntry): string {
  return JSON.stringify([...parseRetentionLog(raw), entry].slice(-RETENTION_LOG_MAX));
}

export function parseRetentionLog(raw: string | null): RetentionLogEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is RetentionLogEntry =>
      !!e && typeof e === 'object' && typeof (e as RetentionLogEntry).at === 'number' && typeof (e as RetentionLogEntry).by === 'string'
      && Array.isArray((e as RetentionLogEntry).changes));
  } catch {
    return [];
  }
}

/** 예약 작업이 쓰는 값 (초). jobStale 이 null 이면 마감일 없는 공고의 자동 마감·그 안내를 하지 않는다. */
export interface RetentionSeconds {
  applicationKeepDays: number;
  applicationAutoCloseDays: number;
  vdocKeep: number;
  accessLogKeep: number;
  jobStale: number | null;
}

export function retentionSeconds(r: RetentionValues): RetentionSeconds {
  return {
    applicationKeepDays: r.application_keep_days,
    applicationAutoCloseDays: r.application_auto_close_days,
    vdocKeep: r.vdoc_keep_days * DAY,
    accessLogKeep: r.access_log_keep_days * DAY,
    jobStale: r.job_stale_days === 0 ? null : r.job_stale_days * DAY,
  };
}
