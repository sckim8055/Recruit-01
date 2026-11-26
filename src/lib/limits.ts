// 사용량 한도와 조건 알림 켜기/끄기 (T-05c 한도 숫자, T-17 관리자 설정). 순수 함수 — test/limits.test.ts.
//
// 한도 숫자의 기본값(DEFAULT_LIMITS)은 이 파일 한 곳에 있다 (lib/quota 가 다시 내보낸다). 실제로 쓰는 값은 칸마다 이 순서로 정한다 (resolveLimits):
//   1) 관리자 설정 — site_settings 'limits' 한 줄(JSON)에 그 칸이 있고, 아래 LIMIT_SPEC 의 범위 안인 정수일 때
//   2) 설정 파일 — 같은 이름의 변수(wrangler.jsonc vars)가 T-05c 의 규칙(0~1,000,000 의 정수)으로 읽힐 때.
//      ALERT_SEND_PER_RUN 만은 예전처럼 최대 10 으로 줄인다 (alertRunCap).
//   3) 코드의 기본값
// 관리자 설정은 저장할 때와 **읽을 때 모두** 범위를 검사한다: DB 에 범위 밖 값이 들어 있으면 그 칸은 없는 것으로 보고 2)·3) 으로 간다.
// 변수의 범위(0~1,000,000)는 예전 그대로다 — 이미 배포된 설정을 바꾸지 않기 위해. 관리자 화면의 범위는 화면에서 넣는 값에만 걸린다.
//
// 조건 알림 켜기/끄기(alerts_enabled)는 관리자 설정 → 기본값(켜짐) 두 단계다 (변수·기능 플래그를 새로 만들지 않았다).
// 구직자에게 보이는 상태는 하나다: alertsPaused = 꺼짐 또는 ALERT_MAIL_SITE_DAY = 0 또는 ALERT_SEND_PER_RUN = 0.

// ───────── 한도 숫자 (T-05c)

export const DEFAULT_LIMITS = {
  /** 기업당 하루 자동 번역 호출: 공고 현지화 + "다시 만들기" + 면접 요청 번역 미리 보기가 이 한 몫을 같이 쓴다. */
  LOCALIZE_PER_COMPANY_DAY: 30,
  /** 사이트 전체 하루 자동 번역 호출 (모든 기업 + 관리자 엔진 비교). 비용 차단기. */
  LOCALIZE_SITE_DAY: 500,
  /** 관리자 한 사람당 하루 엔진 비교 (고른 엔진 하나마다 1). */
  ADMIN_LOCALIZE_TEST_DAY: 50,
  /** 기업당 하루 메일: 면접 요청 + 불합격 통보 + 담당자 초대 메일. */
  MAIL_PER_COMPANY_DAY: 100,
  /** 사이트 전체 하루 기업 메일 (위 세 가지의 합. 로그인 코드·새 지원자 알림·예약 작업 메일은 세지 않는다). */
  MAIL_SITE_DAY: 1000,
  /** 기업당 작성 중인 공고 수 (게재 중·마감이 아닌 공고 = 초안·차단). 하루 횟수가 아니라 개수. */
  DRAFT_JOBS_PER_COMPANY: 20,
  /**
   * 사이트 전체 하루 조건 알림 메일 (T-10, lib/alert-send.ts). Resend 무료 플랜은 하루 100통이고 로그인 인증코드와 같이 쓰므로
   * 알림이 그 몫을 다 쓰지 않게 따로 센다. 위 MAIL_SITE_DAY(기업 메일)와는 다른 몫이다. 0 = 알림 메일을 보내지 않음.
   */
  ALERT_MAIL_SITE_DAY: 40,
} as const;

export type LimitName = keyof typeof DEFAULT_LIMITS;
export type Limits = Record<LimitName, number>;
export const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as LimitName[];

/** 변수로 받을 수 있는 가장 큰 값 (오타로 아주 큰 수를 넣어도 정수 범위 안에 있게). */
export const LIMIT_MAX = 1_000_000;

/** 변수 값 → 한도. 앞뒤 공백을 뺀 0~LIMIT_MAX 의 정수만 받는다. 비었거나 그 밖의 값은 기본값. 0 은 "그 기능을 쓰지 않음". */
export function parseLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!/^\d{1,7}$/.test(s)) return fallback;
  const n = Number(s);
  return n <= LIMIT_MAX ? n : fallback;
}

/** 변수(설정 파일) → 기본값 만으로 정한 한도. 관리자 설정은 보지 않는다 — 실제로 쓰는 값은 resolveLimits / lib/quota.loadLimits. */
export function limitsOf(env: Partial<Record<LimitName, string | undefined>>): Limits {
  return Object.fromEntries(LIMIT_NAMES.map((k) => [k, parseLimit(env[k], DEFAULT_LIMITS[k])])) as Limits;
}

/** 예약 작업 한 번에 처리하는 알림 수: 기본 8, 최대 10 (0 = 끔). 이유는 docs/ARCHITECTURE.md 17-5 (하위 요청 50개). */
export const ALERT_RUN_DEFAULT = 8;
export const ALERT_RUN_MAX = 10;
/** 변수 ALERT_SEND_PER_RUN → 처리 수 (예전 규칙: 잘못된 값은 기본값, 10 보다 크면 10). */
export const alertRunCap = (raw: string | undefined): number => Math.min(parseLimit(raw, ALERT_RUN_DEFAULT), ALERT_RUN_MAX);

// ───────── 관리자 설정 (T-17)

/** site_settings 키. 값은 JSON 한 줄 (StoredLimits 를 serializeStoredLimits 로). */
export const LIMITS_SETTING = 'limits';
/** site_settings 키. 바꾼 기록(최근 20줄, 관리자 id·숫자만)의 JSON 배열. */
export const LIMITS_LOG_SETTING = 'limits.log';
export const LIMITS_LOG_MAX = 20;

/** 관리자가 정하는 칸: 한도 7개 + 예약 작업 한 번의 알림 처리 수. */
export type LimitKey = LimitName | 'ALERT_SEND_PER_RUN';

export interface LimitSpecItem {
  key: LimitKey;
  default: number;
  min: number;
  max: number;
  /** 이 칸은 이 사이트 전체 몫보다 클 수 없다 (같은 사이트 몫을 함께 쓰는 기업·관리자 몫). */
  site?: LimitName;
  /** 하루 몫이면 usage_counters scope, 사이트 몫이면 subject 'site' (확인 화면의 "오늘 쓴 수"). 개수 한도·처리 수는 없음. */
  scope?: string;
  perSubject?: boolean;
}

/**
 * 관리자 화면의 칸(화면 순서)과 범위. 범위의 이유는 locales `adm.lim.why.<키>` 와 docs/ARCHITECTURE.md 15-1.
 * - 번역: 사이트 0~5000 (비용 차단기 — 오입력으로 큰 비용이 나지 않게), 기업 0~5000·관리자 엔진 비교 0~1000 이고 둘 다 사이트 몫 이하.
 * - 기업 메일: 사이트 0~5000 (오입력 방지 상한), 기업 0~5000 이고 사이트 몫 이하.
 * - 초안 개수: 1~100 (0 이면 아무 기업도 공고를 쓸 수 없다. 100 은 기업 하나가 초안을 쌓아 두지 못하게).
 * - 알림 메일: 0~100 (Resend 무료 플랜의 하루 100통 — 로그인 인증코드와 같이 쓴다).
 * - 알림 처리 수: 0~10 (Workers Free 는 cron 실행당 하위 요청 50개, 알림 메일 한 통 = 3개 — 17-5).
 */
export const LIMIT_SPEC: readonly LimitSpecItem[] = [
  { key: 'LOCALIZE_SITE_DAY', default: DEFAULT_LIMITS.LOCALIZE_SITE_DAY, min: 0, max: 5000, scope: 'localize_site' },
  { key: 'LOCALIZE_PER_COMPANY_DAY', default: DEFAULT_LIMITS.LOCALIZE_PER_COMPANY_DAY, min: 0, max: 5000, site: 'LOCALIZE_SITE_DAY', scope: 'localize_company', perSubject: true },
  { key: 'ADMIN_LOCALIZE_TEST_DAY', default: DEFAULT_LIMITS.ADMIN_LOCALIZE_TEST_DAY, min: 0, max: 1000, site: 'LOCALIZE_SITE_DAY', scope: 'admin_localize_test', perSubject: true },
  { key: 'MAIL_SITE_DAY', default: DEFAULT_LIMITS.MAIL_SITE_DAY, min: 0, max: 5000, scope: 'mail_site' },
  { key: 'MAIL_PER_COMPANY_DAY', default: DEFAULT_LIMITS.MAIL_PER_COMPANY_DAY, min: 0, max: 5000, site: 'MAIL_SITE_DAY', scope: 'mail_company', perSubject: true },
  { key: 'DRAFT_JOBS_PER_COMPANY', default: DEFAULT_LIMITS.DRAFT_JOBS_PER_COMPANY, min: 1, max: 100 },
  { key: 'ALERT_MAIL_SITE_DAY', default: DEFAULT_LIMITS.ALERT_MAIL_SITE_DAY, min: 0, max: 100, scope: 'alert_mail_site' },
  { key: 'ALERT_SEND_PER_RUN', default: ALERT_RUN_DEFAULT, min: 0, max: ALERT_RUN_MAX },
];
export const LIMIT_KEYS: readonly LimitKey[] = LIMIT_SPEC.map((s) => s.key);
const SPEC = Object.fromEntries(LIMIT_SPEC.map((s) => [s.key, s])) as Record<LimitKey, LimitSpecItem>;
export const limitSpecOf = (k: LimitKey): LimitSpecItem => SPEC[k];

/** 관리자 화면 안내: Resend 무료 플랜(하루 100통, 로그인 인증코드와 같이 씀)에서 기업 메일 + 알림 메일 한도의 합이 이보다 크면 경고한다 (막지 않는다). */
export const FREE_PLAN_MAIL_WARN = 70;

/** 그 칸에 받을 수 있는 값인가 (정수, 범위 안). */
export function limitInRange(k: LimitKey, n: unknown): n is number {
  const s = SPEC[k];
  return typeof n === 'number' && Number.isInteger(n) && n >= s.min && n <= s.max;
}

/** site_settings 'limits' 에 저장된 것: 관리자가 정한 칸만 (없는 칸은 설정 파일·기본값을 따른다). */
export interface StoredLimits {
  values: Partial<Record<LimitKey, number>>;
  alerts_enabled?: boolean;
}

/** 저장된 줄 해석. JSON 이 아니면 빈 설정. 칸마다 범위 밖·정수 아님이면 그 칸은 없는 것으로 본다 (→ 설정 파일·기본값). */
export function parseStoredLimits(raw: string | null): StoredLimits {
  let v: unknown = null;
  if (raw) {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const vals = o.values && typeof o.values === 'object' && !Array.isArray(o.values) ? (o.values as Record<string, unknown>) : {};
  const values: Partial<Record<LimitKey, number>> = {};
  for (const k of LIMIT_KEYS) if (limitInRange(k, vals[k])) values[k] = vals[k] as number;
  const out: StoredLimits = { values };
  if (typeof o.alerts_enabled === 'boolean') out.alerts_enabled = o.alerts_enabled;
  return out;
}

/** 저장 형식 (칸 순서 고정 — 확인 화면의 "그사이 바뀌었는지" 비교에도 쓴다). */
export function serializeStoredLimits(s: StoredLimits): string {
  const values = Object.fromEntries(LIMIT_KEYS.filter((k) => s.values[k] !== undefined).map((k) => [k, s.values[k]]));
  return JSON.stringify(s.alerts_enabled === undefined ? { values } : { values, alerts_enabled: s.alerts_enabled });
}

export type LimitSource = 'default' | 'env' | 'admin';
export type LimitValues = Record<LimitKey, number>;

export interface EffectiveLimits {
  values: LimitValues;
  alertsEnabled: boolean;
  source: Record<LimitKey, LimitSource> & { alerts_enabled: Exclude<LimitSource, 'env'> };
  /** 설정 파일에 값이 있으면 그 값 (화면에 "설정 파일 값" 으로 보인다). */
  envValues: Partial<Record<LimitKey, number>>;
}

type EnvVars = Partial<Record<LimitKey, string | undefined>>;

/** 변수 한 칸 → 값 (예전 규칙). 비었거나 잘못된 값이면 null. */
function envValue(env: EnvVars, k: LimitKey): number | null {
  const n = parseLimit(env[k], -1);
  if (n < 0) return null;
  return k === 'ALERT_SEND_PER_RUN' ? Math.min(n, ALERT_RUN_MAX) : n;
}

/** 관리자 설정 → 설정 파일 → 기본값. raw = site_settings 'limits' 의 값(없으면 null). */
export function resolveLimits(env: EnvVars, raw: string | null): EffectiveLimits {
  const stored = parseStoredLimits(raw);
  const values = {} as LimitValues;
  const source = {} as EffectiveLimits['source'];
  const envValues: Partial<Record<LimitKey, number>> = {};
  for (const k of LIMIT_KEYS) {
    const e = envValue(env, k);
    if (e !== null) envValues[k] = e;
    const a = stored.values[k];
    if (a !== undefined) { values[k] = a; source[k] = 'admin'; }
    else if (e !== null) { values[k] = e; source[k] = 'env'; }
    else { values[k] = SPEC[k].default; source[k] = 'default'; }
  }
  const alertsEnabled = stored.alerts_enabled ?? true;
  source.alerts_enabled = stored.alerts_enabled === undefined ? 'default' : 'admin';
  return { values, alertsEnabled, source, envValues };
}

/** 한도 7개만 (lib/quota 의 Limits 모양). */
export const limitsFrom = (e: EffectiveLimits): Limits =>
  Object.fromEntries(LIMIT_NAMES.map((k) => [k, e.values[k]])) as Limits;

/**
 * 조건 알림 메일 발송이 멈춘 상태인가 — 구직자에게 보이는 상태는 이것 하나다.
 * 관리자가 껐거나, 하루 알림 메일 한도가 0 이거나, 한 번에 처리하는 수가 0 이면 멈춤.
 */
export const alertsPaused = (e: Pick<EffectiveLimits, 'values' | 'alertsEnabled'>): boolean =>
  !e.alertsEnabled || e.values.ALERT_MAIL_SITE_DAY === 0 || e.values.ALERT_SEND_PER_RUN === 0;

/** 무료 플랜 안내: 기업 메일 + 알림 메일 한도의 합이 70 을 넘는가 (경고만). */
export const mailPlanWarning = (v: Pick<LimitValues, 'MAIL_SITE_DAY' | 'ALERT_MAIL_SITE_DAY'>): boolean =>
  v.MAIL_SITE_DAY + v.ALERT_MAIL_SITE_DAY > FREE_PLAN_MAIL_WARN;

// ───────── 관리자 폼

export type LimitFieldError = 'not_integer' | 'out_of_range' | 'over_site';
export type LimitsForm = Record<LimitKey, string>;

export function readLimitsForm(f: Record<string, unknown>): LimitsForm {
  const s = (x: unknown) => (typeof x === 'string' ? x.trim().slice(0, 10) : '');
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, s(f[k])])) as LimitsForm;
}

export const formFromLimits = (v: LimitValues): LimitsForm =>
  Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(v[k])])) as LimitsForm;

/** 칸마다 오류 하나. 기업·관리자 몫은 같은 폼의 사이트 몫보다 클 수 없다. */
export function validateLimitsForm(
  form: LimitsForm,
): { ok: true; value: LimitValues } | { ok: false; errors: Partial<Record<LimitKey, LimitFieldError>> } {
  const errors: Partial<Record<LimitKey, LimitFieldError>> = {};
  const value = {} as LimitValues;
  for (const k of LIMIT_KEYS) {
    const raw = form[k];
    if (!/^\d{1,6}$/.test(raw)) { errors[k] = 'not_integer'; continue; }
    const n = Number(raw);
    if (!limitInRange(k, n)) { errors[k] = 'out_of_range'; continue; }
    value[k] = n;
  }
  for (const s of LIMIT_SPEC) {
    if (!s.site || errors[s.key] || errors[s.site]) continue;
    if (value[s.key] > value[s.site]) errors[s.key] = 'over_site';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export interface LimitChange { key: LimitKey | 'alerts_enabled'; from: number; to: number }

/**
 * 한도 저장 계획. 관리자 값으로 남기는 칸 = 이미 관리자 값이던 칸 + 지금 쓰는 값과 다르게 바꾼 칸.
 * (설정 파일·기본값을 따르던 칸을 그대로 두면 계속 따른다 — 폼에 그 값이 미리 채워져 있어도.)
 * reset = "기본값으로 되돌리기": 한도 칸의 관리자 값을 모두 지운다 (알림 켜기/끄기는 그대로).
 */
export function planLimitsSave(
  env: EnvVars, current: StoredLimits, next: LimitValues | 'reset',
): { changes: LimitChange[]; stored: StoredLimits; after: EffectiveLimits; before: EffectiveLimits } {
  const before = resolveLimits(env, serializeStoredLimits(current));
  const values: Partial<Record<LimitKey, number>> = {};
  if (next !== 'reset') {
    for (const k of LIMIT_KEYS) {
      if (current.values[k] !== undefined || next[k] !== before.values[k]) values[k] = next[k];
    }
  }
  const stored: StoredLimits = { ...current, values };
  const after = resolveLimits(env, serializeStoredLimits(stored));
  const changes = LIMIT_KEYS.filter((k) => before.values[k] !== after.values[k]).map((k) => ({ key: k, from: before.values[k], to: after.values[k] }));
  return { changes, stored, after, before };
}

/** 알림 켜기/끄기 저장 계획. next = 'reset' 이면 관리자 값을 지운다 (기본값 = 켜짐). 지금과 같은 값을 고르면 저장할 것이 없다. */
export function planAlertsSave(
  env: EnvVars, current: StoredLimits, next: boolean | 'reset',
): { changes: LimitChange[]; stored: StoredLimits; after: EffectiveLimits; before: EffectiveLimits } {
  const before = resolveLimits(env, serializeStoredLimits(current));
  const stored: StoredLimits = { values: { ...current.values } };
  if (next !== 'reset') {
    if (current.alerts_enabled !== undefined || next !== before.alertsEnabled) stored.alerts_enabled = next;
  }
  const after = resolveLimits(env, serializeStoredLimits(stored));
  const changes = before.alertsEnabled === after.alertsEnabled ? []
    : [{ key: 'alerts_enabled' as const, from: before.alertsEnabled ? 1 : 0, to: after.alertsEnabled ? 1 : 0 }];
  return { changes, stored, after, before };
}

/** 폼의 알림 값: '1' = 켜기, '0' = 끄기, 그 밖은 null. */
export const readAlertsChoice = (v: unknown): boolean | null => (v === '1' ? true : v === '0' ? false : null);

export interface LimitsLogEntry { at: number; by: string; reset?: boolean; changes: LimitChange[] }

export function appendLimitsLog(raw: string | null, entry: LimitsLogEntry): string {
  return JSON.stringify([...parseLimitsLog(raw), entry].slice(-LIMITS_LOG_MAX));
}

export function parseLimitsLog(raw: string | null): LimitsLogEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is LimitsLogEntry =>
      !!e && typeof e === 'object' && typeof (e as LimitsLogEntry).at === 'number' && typeof (e as LimitsLogEntry).by === 'string'
      && Array.isArray((e as LimitsLogEntry).changes));
  } catch {
    return [];
  }
}
