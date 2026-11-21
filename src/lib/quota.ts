// 남용 방지 한도 (T-05c). 운영자가 비용을 내는 것(번역 API 호출·메일 발송)과 누구나 만들 수 있는 것(공고 초안)에 하루·개수 한도를 둔다.
// 한도 숫자는 이 파일 한 곳(DEFAULT_LIMITS)에 있고, 같은 이름의 변수(wrangler.jsonc vars / 대시보드)로 바꿀 수 있다 (limitsOf).
//
// - 하루는 한국 시간(UTC+9) 0시에 바뀐다 (kstDay). 횟수는 usage_counters 에 (범위, 대상, 날짜) 마다 센다 — 대상은 id 또는 'site' 뿐이다.
// - 기업 몫을 먼저 잡고 그다음 사이트 전체 몫을 잡는다. 사이트 몫이 거절되면 기업 몫은 이미 하나 쓴 것으로 남는다 (되돌리지 않는다 — 단순하게).
// - 한도를 잡은 뒤 엔진·메일이 실패해도 되돌리지 않는다 (src/db/usage.ts).
// - 로그인 인증코드 메일은 세지 않는다 (로그인 흐름은 lib/auth.ts 의 이메일당 60초 제한만 쓴다).
import type { Env, Locale } from '../env';
import { t } from './i18n';
import { readUsage, takeQuota } from '../db/usage';

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

export function limitsOf(env: Partial<Record<LimitName, string | undefined>>): Limits {
  return Object.fromEntries(LIMIT_NAMES.map((k) => [k, parseLimit(env[k], DEFAULT_LIMITS[k])])) as Limits;
}

/** usage_counters 행을 남기는 날 수. 이보다 오래된 날짜의 행은 예약 작업 dropOldRows 가 지운다 (개인정보는 없지만 쌓이지 않게). */
export const USAGE_KEEP_DAYS = 35;

const KST = 9 * 3600;
/** 에포크 초 → 한국 시간 날짜 'YYYY-MM-DD'. */
export const kstDay = (ts: number): string => new Date((ts + KST) * 1000).toISOString().slice(0, 10);

/** usage_counters.scope 값. */
export const SCOPES = {
  localizeCompany: 'localize_company',
  localizeSite: 'localize_site',
  adminTest: 'admin_localize_test',
  mailCompany: 'mail_company',
  mailSite: 'mail_site',
} as const;
/** 사이트 전체 몫의 subject. */
export const SITE = 'site';

/** 한도에 걸렸을 때의 문구 키. 숫자는 {n} 으로 넣는다 (quotaText). */
export const QUOTA_MSG = {
  localizeCompany: 'quota.localize.company',
  localizeSite: 'quota.localize.site',
  previewCompany: 'quota.preview.company',
  previewSite: 'quota.preview.site',
  adminTest: 'quota.admin_test',
  adminTestSite: 'quota.admin_test.site',
  mailCompany: 'quota.mail.company',
  mailSite: 'quota.mail.site',
  inviteCompany: 'quota.invite.company',
  inviteSite: 'quota.invite.site',
  rejectUnsent: 'quota.reject.unsent',
  drafts: 'quota.drafts',
} as const;

export const fillN = (s: string, v: Record<string, string | number>): string =>
  Object.entries(v).reduce((acc, [k, x]) => acc.replaceAll(`{${k}}`, String(x)), s);

/** 문구 키 + 숫자 → 화면 글. */
export const quotaText = (l: Locale, key: string, v: Record<string, string | number> = {}): string => fillN(t(l, key), v);

/** 어느 몫에서 거절됐는지와 그 몫의 한도. */
export type Pool = 'company' | 'site' | 'admin';
export type QuotaTake = { ok: true } | { ok: false; pool: Pool; limit: number };

type Env2 = Pick<Env, 'DB'> & Partial<Record<LimitName, string>>;

/** 앞 몫(기업·관리자) → 사이트 몫 차례로. 앞 몫이 거절되면 사이트 몫은 건드리지 않는다. */
async function takeTwo(
  env: Env2, first: { scope: string; subject: string; limit: number; pool: Pool }, site: { scope: string; limit: number }, ts: number, cost = 1,
): Promise<QuotaTake> {
  const day = kstDay(ts);
  if (!await takeQuota(env.DB, { scope: first.scope, subject: first.subject, day, limit: first.limit, ts, cost })) {
    return { ok: false, pool: first.pool, limit: first.limit };
  }
  if (!await takeQuota(env.DB, { scope: site.scope, subject: SITE, day, limit: site.limit, ts, cost })) {
    return { ok: false, pool: 'site', limit: site.limit };
  }
  return { ok: true };
}

/** 자동 번역 한 번 (공고 현지화·다시 만들기·면접 요청 번역 미리 보기). 엔진을 부르기 직전에, 엔진이 있을 때만 부른다. */
export function takeLocalize(env: Env2, companyId: string, ts: number): Promise<QuotaTake> {
  const L = limitsOf(env);
  return takeTwo(env, { scope: SCOPES.localizeCompany, subject: companyId, limit: L.LOCALIZE_PER_COMPANY_DAY, pool: 'company' },
    { scope: SCOPES.localizeSite, limit: L.LOCALIZE_SITE_DAY }, ts);
}

/** 관리자 엔진 비교: 고른 엔진 수만큼 (관리자 몫 + 사이트 번역 몫). */
export function takeAdminLocalizeTest(env: Env2, adminId: string, ts: number, cost: number): Promise<QuotaTake> {
  const L = limitsOf(env);
  return takeTwo(env, { scope: SCOPES.adminTest, subject: adminId, limit: L.ADMIN_LOCALIZE_TEST_DAY, pool: 'admin' },
    { scope: SCOPES.localizeSite, limit: L.LOCALIZE_SITE_DAY }, ts, cost);
}

/** 기업이 보내는 메일 한 통 (면접 요청·불합격 통보·담당자 초대). 메일 핵심 함수를 부르기 전에. */
export function takeCompanyMail(env: Env2, companyId: string, ts: number): Promise<QuotaTake> {
  const L = limitsOf(env);
  return takeTwo(env, { scope: SCOPES.mailCompany, subject: companyId, limit: L.MAIL_PER_COMPANY_DAY, pool: 'company' },
    { scope: SCOPES.mailSite, limit: L.MAIL_SITE_DAY }, ts);
}

export interface UsageLine { n: number; limit: number }
export interface TodayUsage { day: string; localize: UsageLine; mail: UsageLine }

/** 관리자 첫 화면의 "오늘 사용량": 사이트 전체 번역 호출·기업 메일 (읽기 두 번). */
export async function todayUsage(env: Env2, ts: number): Promise<TodayUsage> {
  const L = limitsOf(env);
  const day = kstDay(ts);
  const [localize, mail] = await Promise.all([
    readUsage(env.DB, { scope: SCOPES.localizeSite, subject: SITE, day }),
    readUsage(env.DB, { scope: SCOPES.mailSite, subject: SITE, day }),
  ]);
  return { day, localize: { n: localize, limit: L.LOCALIZE_SITE_DAY }, mail: { n: mail, limit: L.MAIL_SITE_DAY } };
}
