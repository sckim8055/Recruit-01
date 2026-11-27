// 남용 방지 한도 (T-05c). 운영자가 비용을 내는 것(번역 API 호출·메일 발송)과 누구나 만들 수 있는 것(공고 초안)에 하루·개수 한도를 둔다.
// 한도 숫자의 기본값은 lib/limits.ts 한 곳(DEFAULT_LIMITS)에 있다. 실제로 쓰는 값은 관리자 설정(/admin/settings, T-17) → 같은 이름의 변수
// (.env, T-19 전에는 wrangler.jsonc vars) → 기본값 순서로 칸마다 정한다 (loadLimits, lib/limits.resolveLimits). 몫을 잡을 때마다 설정 한 행을 읽는다(캐시 없음).
//
// - 하루 몫은 한국 시간 0시(= UTC 15:00)에 새 날짜 행으로 시작한다. 한도를 바꿔도 오늘 이미 센 수는 그대로다 (소급해서 지우거나 되돌리지 않는다).
// - 하루는 한국 시간(UTC+9) 0시에 바뀐다 (kstDay). 횟수는 usage_counters 에 (범위, 대상, 날짜) 마다 센다 — 대상은 id 또는 'site' 뿐이다.
// - 기업 몫을 먼저 잡고 그다음 사이트 전체 몫을 잡는다. 사이트 몫이 거절되면 기업 몫은 이미 하나 쓴 것으로 남는다 (되돌리지 않는다 — 단순하게).
// - 한도를 잡은 뒤 엔진·메일이 실패해도 되돌리지 않는다 (src/db/usage.ts).
// - 로그인 인증코드 메일은 세지 않는다 (로그인 흐름은 lib/auth.ts 의 이메일당 60초 제한만 쓴다).
import type { Env, Locale } from '../env';
import { t } from './i18n';
import { readUsage, takeQuota } from '../db/usage';
import { getSetting } from '../db/settings';
import { limitsFrom, resolveLimits, LIMITS_SETTING, type EffectiveLimits, type LimitKey, type Limits } from './limits';

// 한도 숫자·변수 해석·관리자 설정(T-17)은 lib/limits.ts 에 있다 (순환 import 를 피하려고 옮김). 예전 이름으로도 쓸 수 있게 다시 내보낸다.
export { DEFAULT_LIMITS, LIMIT_MAX, LIMIT_NAMES, limitsOf, parseLimit, type LimitName, type Limits } from './limits';

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
  alertMailSite: 'alert_mail_site',
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

type Env2 = Pick<Env, 'DB'> & Partial<Record<LimitKey, string>>;

/** 미리 읽은 한도가 있으면 그것을, 없으면 한 번 읽는다 (불합격 묶음처럼 한 요청에서 여러 번 잡을 때 한 번만 읽게). */
const limitsFor = async (env: Env2, L?: Limits): Promise<Limits> => L ?? limitsFrom(await loadLimits(env));

/**
 * 지금 쓰는 한도 (관리자 설정 → 설정 파일 → 기본값, lib/limits.resolveLimits). site_settings 기본 키 한 행을 읽는다 (D1 읽기 1).
 * 따로 캐시하지 않는다 — 저장하면 다음 요청부터 바로 바뀐다. 한도를 잡는 경로(몫 잡기)·관리자 화면·조건 알림 화면에서만 부른다
 * (비로그인 캐시 화면에서는 부르지 않는다).
 */
export async function loadLimits(env: Env2): Promise<EffectiveLimits> {
  return resolveLimits(env, await getSetting(env.DB, LIMITS_SETTING));
}

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
export async function takeLocalize(env: Env2, companyId: string, ts: number, limits?: Limits): Promise<QuotaTake> {
  const L = await limitsFor(env, limits);
  return takeTwo(env, { scope: SCOPES.localizeCompany, subject: companyId, limit: L.LOCALIZE_PER_COMPANY_DAY, pool: 'company' },
    { scope: SCOPES.localizeSite, limit: L.LOCALIZE_SITE_DAY }, ts);
}

/** 관리자 엔진 비교: 고른 엔진 수만큼 (관리자 몫 + 사이트 번역 몫). */
export async function takeAdminLocalizeTest(env: Env2, adminId: string, ts: number, cost: number, limits?: Limits): Promise<QuotaTake> {
  const L = await limitsFor(env, limits);
  return takeTwo(env, { scope: SCOPES.adminTest, subject: adminId, limit: L.ADMIN_LOCALIZE_TEST_DAY, pool: 'admin' },
    { scope: SCOPES.localizeSite, limit: L.LOCALIZE_SITE_DAY }, ts, cost);
}

/** 기업이 보내는 메일 한 통 (면접 요청·불합격 통보·담당자 초대). 메일 핵심 함수를 부르기 전에. */
export async function takeCompanyMail(env: Env2, companyId: string, ts: number, limits?: Limits): Promise<QuotaTake> {
  const L = await limitsFor(env, limits);
  return takeTwo(env, { scope: SCOPES.mailCompany, subject: companyId, limit: L.MAIL_PER_COMPANY_DAY, pool: 'company' },
    { scope: SCOPES.mailSite, limit: L.MAIL_SITE_DAY }, ts);
}

export interface UsageLine { n: number; limit: number }

/** 관리자 시스템 화면: 오늘(한국 시간) 보낸 조건 알림 메일 수와 한도 (T-10, 읽기 한 번). */
export async function todayAlertMail(env: Env2, ts: number, limits?: Limits): Promise<UsageLine> {
  const [n, L] = await Promise.all([readUsage(env.DB, { scope: SCOPES.alertMailSite, subject: SITE, day: kstDay(ts) }), limitsFor(env, limits)]);
  return { n, limit: L.ALERT_MAIL_SITE_DAY };
}
export interface TodayUsage { day: string; localize: UsageLine; mail: UsageLine }

/** 관리자 첫 화면의 "오늘 사용량": 사이트 전체 번역 호출·기업 메일 (읽기 두 번). */
export async function todayUsage(env: Env2, ts: number, limits?: Limits): Promise<TodayUsage> {
  const day = kstDay(ts);
  const [localize, mail, L] = await Promise.all([
    readUsage(env.DB, { scope: SCOPES.localizeSite, subject: SITE, day }),
    readUsage(env.DB, { scope: SCOPES.mailSite, subject: SITE, day }),
    limitsFor(env, limits),
  ]);
  return { day, localize: { n: localize, limit: L.LOCALIZE_SITE_DAY }, mail: { n: mail, limit: L.MAIL_SITE_DAY } };
}
