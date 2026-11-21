// 개인정보처리방침·동의 문구의 보관 기간 채우기 (T-12c). 순수 함수 — test/retention.test.ts.
// 본문(privacy.ts)과 locales 의 몇 문구는 관리자가 바꾸는 기간을 `{이름}` 으로 두고, 화면에 내보낼 때 여기서 지금 설정값으로 채운다.
// 그래서 방침·동의 화면에 보이는 숫자는 항상 예약 작업이 실제로 쓰는 숫자와 같다 (lib/retention).
import type { Locale } from '../env';
import { t } from '../lib/i18n';
import type { RetentionValues } from '../lib/retention';
import { LEGAL_PARAMS, type LegalDoc, type LegalParam } from './types';

const days = (l: Locale, n: number) => (l === 'zh' ? `${n}天` : `${n}일`);
/** 365 로 나누어떨어지면 연 단위 ("1년" · "2年"), 아니면 일 단위. */
const yearsOrDays = (l: Locale, n: number) => (n % 365 === 0 ? (l === 'zh' ? `${n / 365}年` : `${n / 365}년`) : days(l, n));

/** 자리표시자 → 그 언어의 글 (단위 포함). */
export function legalParams(l: Locale, r: RetentionValues): Record<LegalParam, string> {
  return {
    application_keep_days: days(l, r.application_keep_days),
    application_auto_close_days: days(l, r.application_auto_close_days),
    vdoc_keep: yearsOrDays(l, r.vdoc_keep_days),
    access_log_keep: yearsOrDays(l, r.access_log_keep_days),
    stale_days: days(l, r.job_stale_days),
  };
}

const PARAM_RE = new RegExp(`\\{(${LEGAL_PARAMS.join('|')})\\}`, 'g');

/** 글 안의 알려진 자리표시자만 채운다 ({n}·{date} 같은 다른 자리표시자는 그대로 둔다). */
export const fillLegal = (s: string, p: Record<LegalParam, string>): string => s.replace(PARAM_RE, (_, k: LegalParam) => p[k]);

const renderDoc = (doc: LegalDoc, p: Record<LegalParam, string>): LegalDoc => ({
  title: fillLegal(doc.title, p),
  effective: fillLegal(doc.effective, p),
  intro: doc.intro.map((x) => fillLegal(x, p)),
  sections: doc.sections.map((s) => ({ h: fillLegal(s.h, p), items: s.items.map((x) => fillLegal(x, p)) })),
});

/** 문서(한국어·중국어)를 지금 보관 기간으로 채운다. */
export function renderLegal(docs: Record<Locale, LegalDoc>, r: RetentionValues): Record<Locale, LegalDoc> {
  return { ko: renderDoc(docs.ko, legalParams('ko', r)), zh: renderDoc(docs.zh, legalParams('zh', r)) };
}

/** 보관 기간 자리표시자가 든 화면 문구 (consent.privacy.keep, apply.consent.*.text, mail.job_close.*). */
export const tRetention = (l: Locale, key: string, r: RetentionValues): string => fillLegal(t(l, key), legalParams(l, r));

/** 기간 자리표시자를 쓰는 화면 문구 키 (테스트가 모두 채워지는지 확인한다). */
export const RETENTION_TEXT_KEYS = [
  'consent.privacy.keep', 'apply.consent.optional.text', 'apply.consent.required.text',
  'mail.job_close.reason.stale', 'mail.job_close.stale_line',
] as const;
