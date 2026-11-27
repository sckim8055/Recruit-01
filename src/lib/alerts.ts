// 조건 알림 (T-10). 순수 함수만 둔다 (DB·네트워크 접근 없음) — test/alerts.test.ts.
//
// 무엇인가: 구직자가 /jobs 에서 **직접 고른 검색 조건**을 저장해 두고, 그 조건에 맞는 **새로 게재된 공고**를 메일로 받는 것.
// 구직자 자신의 기준으로 정보를 전하는 것이고, 추천·알선이 아니다 (CLAUDE.md 규칙 1):
// - 이력서·지원 기록·행동을 쓰지 않는다. "잘 맞는 공고" 순위·점수·"관심 있을 만한 공고" 가 없다. 운영자가 고른 공고·유료 노출이 없다.
// - 순서는 게재 최신 순뿐이다 (/jobs 와 같은 published_at DESC, id DESC). 메일에 나오는 공고는 같은 조건의 /jobs 에 보이는 공고뿐이다 (publicJobWhere).
// - 기업이 구직자에게 알림을 보내게 하는 길, 관리자가 고른 구직자에게 공고를 보내는 길은 없다. 관리자에게는 개수만 보인다.
//
// 조건의 모양: /jobs 가 받는 검색 조건과 **같은 것**(lib/public-jobs.parseJobFilter 로 만든 JobFilter)을 FILTER_KEYS 순서의 JSON 객체로 저장한다.
// 다른 조건 문법을 만들지 않는다. /jobs 에는 검색어 칸이 없으므로 검색어도 저장하지 않는다.
import type { Locale } from '../env';
import { t } from './i18n';
import { findOption, isActiveCode, labelOf, type OptionSet } from './options';
import {
  FILTER_KEYS, FILTER_LABEL_KEYS, FIXED_FILTER_CHOICES, filterValueLabel, isOptionFilter, jobsHref, parseJobFilter,
  type FilterChoices, type FilterKey, type JobFilter,
} from './public-jobs';
import { ALERT_RUN_DEFAULT, ALERT_RUN_MAX, alertRunCap } from './limits';

export const DAY = 86_400;
const KST = 9 * 3600;

/** 한 구직자가 만들 수 있는 알림 수. */
export const ALERT_MAX_PER_USER = 5;
/** 메일에 적는 공고 수. 더 있으면 "외 N건" + /jobs 주소. */
export const ALERT_MAX_LISTED = 10;
/** 연속 발송 실패가 이만큼이면 알림을 멈춘다 (paused_reason = 'failures'). */
export const ALERT_MAX_FAILURES = 5;
/** 보내는 시각: 한국 시간 09:00. 매주 알림은 월요일 09:00. */
export const ALERT_SEND_HOUR_KST = 9;
/**
 * 보내지 않는 시간: 한국 시간 21:00 ~ 08:00 (정보통신망법 제50조 제3항의 야간 광고성 정보 전송 제한).
 * 이 메일이 "광고성 정보" 인지는 정해지지 않았다(전문가 확인 필요) — 보수적으로 광고성으로 보고 지킨다.
 */
export const NIGHT_START_KST = 21;
export const NIGHT_END_KST = 8;
/** 쓰지 않거나 멈춘 지 이만큼 지난 알림은 예약 작업이 지운다 (12개월). */
export const ALERT_UNUSED_DELETE_AFTER = 365 * DAY;
/** 해지 링크 토큰을 남기는 기간. 이보다 오래된 메일의 링크는 "만료" 안내를 보인다 (로그인해서 끌 수 있다). */
export const ALERT_TOKEN_KEEP = 180 * DAY;
/** 알림 메일 수신 동의 문구의 판. 문구(locales 'alert.optin*')를 바꾸면 올린다. 알림 행(optin_version)에 남는다. */
export const ALERT_OPTIN_VERSION = 'alert-optin-2026-11-1';

/** 예약 작업 한 번에 처리하는 알림 수: 기본 8, 최대 50 (0 = 끔, T-19 전 최대 10 — Workers 하위 요청 50개). docs/ARCHITECTURE.md 17절. 값은 lib/limits (관리자 설정 → 변수 → 기본값). */
export { ALERT_RUN_DEFAULT, ALERT_RUN_MAX, alertRunCap };

export type AlertFrequency = 'daily' | 'weekly';
export const ALERT_FREQUENCIES: readonly AlertFrequency[] = ['daily', 'weekly'];
export const readFrequency = (v: unknown): AlertFrequency | null => (v === 'daily' || v === 'weekly' ? v : null);
export type AlertStatus = 'active' | 'paused';
export type PausedReason = 'user' | 'unsubscribe' | 'failures';

// ── 시간

/** 한국 시간의 시(0~23). */
export const kstHour = (ts: number): number => Math.floor((((ts + KST) % DAY) + DAY) % DAY / 3600);

/** 보내도 되는 시각인가: 한국 시간 08:00 ≤ 시각 < 21:00. */
export const inSendWindow = (ts: number): boolean => {
  const h = kstHour(ts);
  return h >= NIGHT_END_KST && h < NIGHT_START_KST;
};

/**
 * 다음에 보낼 차례: `after` **보다 뒤의** 첫 한국 시간 09:00 (매주는 월요일 09:00).
 * 만들 때·보낸 뒤·새 공고가 없어 넘긴 뒤·빈도를 바꾸거나 다시 켤 때 그 시각으로 계산한다 → 늦게 처리돼도 하루(한 주)에 한 번.
 */
export function nextDueAt(freq: AlertFrequency, after: number): number {
  const local = after + KST;
  let at = Math.floor(local / DAY) * DAY + ALERT_SEND_HOUR_KST * 3600;
  if (at <= local) at += DAY;
  if (freq === 'weekly') while (new Date(at * 1000).getUTCDay() !== 1) at += DAY; // 1 = 월요일 (한국 시간 날짜로 계산 중)
  return at - KST;
}

// ── 조건

/**
 * 만들 때: 폼(= /jobs 의 검색 조건을 숨은 칸으로 그대로 보낸 것)을 /jobs 와 같은 파서로 읽는다.
 * 보이는 필터(관리자 설정)·사용 중인 항목 밖의 값은 /jobs 와 똑같이 버려진다. 조건이 하나도 없으면 null (모든 새 공고 알림은 만들지 않는다).
 */
export function normalizeAlertFilter(form: Record<string, string | undefined>, enabled: readonly FilterKey[], choices: FilterChoices): JobFilter | null {
  const f = parseJobFilter(form, enabled, choices);
  return FILTER_KEYS.some((k) => f[k] !== undefined) ? f : null;
}

/** 저장할 값: FILTER_KEYS 순서의 JSON 객체 (같은 조건이면 같은 글자 — 같은 조건 알림 중복 확인에 쓴다). */
export function serializeFilter(f: JobFilter): string {
  const o: Record<string, string> = {};
  for (const k of FILTER_KEYS) { const v = f[k]; if (v !== undefined) o[k] = v; }
  return JSON.stringify(o);
}

/**
 * 저장된 값 → 조건. 알려진 이름과, 고정 목록 값 또는 job_options 에 **있는**(사용 중이든 사용 종료든) code 만 남긴다.
 * 사용 종료된 항목 값은 버리지 않는다 — 버리면 조건이 넓어져 구직자가 고르지 않은 공고까지 보내게 된다 (그 항목의 공고만 계속 찾는다).
 * JSON 이 아니거나 객체가 아니면 빈 조건.
 */
export function parseStoredFilter(raw: string, set: OptionSet): JobFilter {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: JobFilter = {};
  for (const k of FILTER_KEYS) {
    const x = o[k];
    if (typeof x !== 'string') continue;
    const ok = isOptionFilter(k) ? !!findOption(set, k, x) : (FIXED_FILTER_CHOICES[k] as readonly string[]).includes(x);
    if (ok) out[k] = x;
  }
  return out;
}

/**
 * 보낼 때 실제로 쓰는 조건: 관리자가 /jobs 에서 숨긴 필터는 /jobs 가 무시하는 것과 똑같이 무시한다 (알림 화면에 그렇게 적는다).
 * ignored = 저장돼 있지만 지금은 적용되지 않는 필터. 남는 조건이 없으면 메일을 보내지 않는다 (조건 없는 "모든 새 공고" 메일이 되지 않게).
 */
export function effectiveFilter(stored: JobFilter, enabled: readonly FilterKey[]): { filter: JobFilter; ignored: FilterKey[] } {
  const filter: JobFilter = {};
  const ignored: FilterKey[] = [];
  for (const k of FILTER_KEYS) {
    const v = stored[k];
    if (v === undefined) continue;
    if (enabled.includes(k)) filter[k] = v;
    else ignored.push(k);
  }
  return { filter, ignored };
}

export const isEmptyFilter = (f: JobFilter): boolean => FILTER_KEYS.every((k) => f[k] === undefined);

export interface SummaryItem { key: FilterKey; name: string; value: string; retired: boolean; ignored: boolean }

/** 조건 요약 (지금 항목 이름으로). 사용 종료된 항목도 이름이 나온다(retired). 숨긴 필터는 ignored. */
export function filterSummaryItems(stored: JobFilter, locale: Locale, set: OptionSet, enabled: readonly FilterKey[]): SummaryItem[] {
  return FILTER_KEYS.filter((k) => stored[k] !== undefined).map((k) => {
    const v = stored[k]!;
    return {
      key: k, name: t(locale, FILTER_LABEL_KEYS[k]), value: filterValueLabel(locale, set, k, v),
      retired: isOptionFilter(k) ? !isActiveCode(set, k, v) : false, ignored: !enabled.includes(k),
    };
  });
}

/** 한 줄 요약: "근무지: 서울 · 중국어 수준: 비즈니스". 숨긴 필터는 뺀다 (메일에는 실제로 쓴 조건만). */
export function filterSummaryText(items: SummaryItem[], locale: Locale, withIgnored = false): string {
  const sep = locale === 'zh' ? '：' : ': ';
  return items.filter((i) => withIgnored || !i.ignored)
    .map((i) => `${i.name}${sep}${i.value}${i.retired ? ` (${t(locale, 'alert.retired')})` : ''}`).join(' · ');
}

// ── 주소·토큰

export const isAlertId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
/** 해지 토큰 = 32바이트 base64url (43자, crypto.randomToken). */
export const isUnsubToken = (s: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(s);
export const UNSUB_PATH_PREFIX = '/alerts/u/';
const ONE_CLICK_PATH = /^\/alerts\/u\/[A-Za-z0-9_-]{43}$/;

/** 동의 확인(T-11)에서 건너뛰는 주소: 해지 화면. 동의를 다시 하지 않은 회원도 메일을 끌 수 있어야 한다. */
export const isUnsubscribePath = (path: string): boolean => path.startsWith(UNSUB_PATH_PREFIX);

/**
 * 출처 검사(sameOrigin)에서 빼는 **유일한** 요청: RFC 8058 한 번 클릭 해지 `POST /alerts/u/<토큰>`.
 * 메일 프로그램이 쿠키·Origin 없이 보내므로 출처를 확인할 수 없다 — 토큰이 권한이다. 이 요청이 하는 일은 그 알림 하나를 멈추는 것뿐이다.
 * 경로가 정확히 이 모양일 때만(뒤에 /all 등이 붙으면 아님), POST 일 때만.
 */
export const isOneClickUnsubscribe = (method: string, path: string): boolean => method === 'POST' && ONE_CLICK_PATH.test(path);

// ── 메일

export interface AlertMailJob {
  id: string;
  title_ko: string | null;
  company_name: string | null; // 기업명 비공개면 NULL
  location: string | null;
  closes_at: number | null;
}

const oneLine = (s: string, max: number): string => {
  const x = s.replace(/[\r\n\t]+/g, ' ').trim();
  return [...x].length > max ? `${[...x].slice(0, max).join('')}…` : x;
};

const kstDateText = (ts: number): string => new Date((ts + KST) * 1000).toISOString().slice(0, 10);

/** 운영자 정보 한 줄. 이름·사업자등록번호에 【확인 필요】/【待确认】 자리표시자가 남아 있으면 줄을 넣지 않는다 (자리표시자를 메일로 보내지 않는다). */
export function operatorLine(locale: Locale, op: { name: string; bizNo: string }): string | null {
  if (/【/.test(op.name) || /【/.test(op.bizNo) || !op.name.trim()) return null;
  return t(locale, 'alert.mail.operator').replaceAll('{name}', op.name).replaceAll('{biz_no}', op.bizNo);
}

export interface AlertMailInput {
  locale: Locale;
  origin: string;
  frequency: AlertFrequency;
  summary: string;         // filterSummaryText (실제로 쓴 조건)
  filter: JobFilter;       // "외 N건" 의 /jobs 주소
  jobs: AlertMailJob[];    // 최신 게재 순, 최대 ALERT_MAX_LISTED
  total: number;           // 이번에 새로 맞는 공고 전체 수 (jobs.length 이상)
  token: string;           // 이 메일의 해지 토큰 (원문 — 메일에만 들어간다)
  set: OptionSet;          // 근무지 이름
  operator: string | null; // operatorLine
}

/**
 * 조건 알림 메일. 받는 사람의 이메일 말고는 개인정보가 없다 (이름·이력서·지원 기록을 넣지 않는다 — 규칙 5).
 * 공고마다 제목 · 기업(비공개면 "기업명 비공개") · 근무지 · 마감일 · 주소. 머리글 List-Unsubscribe(+ One-Click, RFC 8058).
 * 제목에 "(광고)" 를 붙이지 않는다 — 광고성 정보인지 정해지지 않았다 (docs/TASKS.md T-10 의 열린 질문).
 */
export function buildAlertMail(i: AlertMailInput): { subject: string; text: string; headers: Record<string, string> } {
  const l = i.locale;
  const base = i.origin.replace(/\/+$/, '');
  const unsub = `${base}${UNSUB_PATH_PREFIX}${i.token}`;
  const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);
  const site = t(l, 'site.name');
  const lines: string[] = [];
  lines.push(fill(t(l, 'alert.mail.intro'), { site }));
  lines.push('');
  lines.push(`${t(l, 'alert.mail.filter')} ${i.summary}`);
  lines.push(fill(t(l, 'alert.mail.count'), { n: i.total }));
  lines.push('');
  i.jobs.forEach((j, n) => {
    const company = j.company_name ? oneLine(j.company_name, 60) : t(l, 'pj.company_hidden');
    const meta = [company, labelOf(i.set, 'location', j.location, l),
      `${t(l, 'alert.mail.deadline')} ${j.closes_at == null ? t(l, 'pj.closes.none') : kstDateText(j.closes_at)}`].filter(Boolean).join(' · ');
    lines.push(`${n + 1}. ${oneLine(j.title_ko || t(l, 'job.untitled'), 120)}`);
    lines.push(`   ${meta}`);
    lines.push(`   ${base}/jobs/${j.id}`);
  });
  const more = i.total - i.jobs.length;
  if (more > 0) {
    lines.push('');
    lines.push(`${fill(t(l, 'alert.mail.more'), { n: more })} ${base}${jobsHref(i.filter)}`);
  }
  lines.push('');
  lines.push('----------------------------------------');
  lines.push(fill(t(l, 'alert.mail.why'), { site, freq: t(l, `alert.freq.${i.frequency}`) }));
  lines.push(`${t(l, 'alert.mail.manage')} ${base}/my/alerts`);
  lines.push(`${t(l, 'alert.mail.unsub')} ${unsub}`);
  if (i.operator) lines.push(i.operator);
  return {
    subject: fill(t(l, 'alert.mail.subject'), { n: i.total }),
    text: lines.join('\n'),
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

/** 이번 실행에 보낼 수 있는 메일 수: 하루 알림 메일 한도에서 오늘 쓴 수를 뺀 것과 보낼 알림 수 중 작은 것 (0 이하이면 0). */
export const mailsAllowed = (want: number, used: number, limit: number): number => Math.max(0, Math.min(want, limit - used));
