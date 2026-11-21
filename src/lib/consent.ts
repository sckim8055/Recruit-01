// 이용약관·개인정보 처리 동의 (T-11). 순수 함수 — test/account.test.ts.
//
// - 로그인한 회원(관리자 제외)은 지금 판(版)의 이용약관·개인정보 수집·이용에 동의해야 서비스를 쓸 수 있다.
//   동의가 없으면 /consent 로 보낸다. 문서를 고쳐 판을 올리면 다시 묻게 된다.
// - 동의하지 않고도 할 수 있어야 하는 것: 문서 읽기, 언어 바꾸기, 로그아웃, **회원 탈퇴** (동의를 거부한 사람이 나갈 수 있어야 한다).
// - 국외 이전 동의(cross_border)는 지원할 때 따로 받는다 (lib/application.ts).
// - 문서 본문은 src/legal/ 에 있다. 본문을 바꾸면 아래 판을 올린다.

/** 문서의 판. consents.version 에 남는다. 본문(src/legal/terms.ts · privacy.ts)을 고치면 올린다. 개인정보처리방침의 실제 판은 privacyVersion(). */
export const TERMS_VERSION = '2026-11-1';
export const PRIVACY_VERSION = '2026-11-1';

export type RequiredConsent = 'terms' | 'privacy';
export type RequiredConsentItem = { type: RequiredConsent; version: string };
export const REQUIRED_CONSENT_TYPES: readonly RequiredConsent[] = ['terms', 'privacy'];

/**
 * 지금 개인정보처리방침의 판 (T-12c). 관리자가 개인정보 보관 기간을 한 번도 늘린 적이 없으면 PRIVACY_VERSION 그대로,
 * 늘린 적이 있으면 `${PRIVACY_VERSION}+r<n>` (n = 보관 기간 설정의 rev — 개인정보 기간을 늘릴 때만 오른다, lib/retention.planRetentionSave).
 * 판이 바뀌면 회원은 다음 요청에서 /consent 로 가서 개인정보 동의만 다시 한다. 줄이기·자동 마감·자동 종료를 바꾸는 것은 판을 바꾸지 않는다.
 */
export function privacyVersion(retention: { rev: number }): string {
  return retention.rev > 0 ? `${PRIVACY_VERSION}+r${retention.rev}` : PRIVACY_VERSION;
}

/** 지금 받아야 하는 필수 동의(종류·판). 판은 보관 기간 설정에 따라 바뀐다. */
export function requiredConsents(retention: { rev: number }): RequiredConsentItem[] {
  return [
    { type: 'terms', version: TERMS_VERSION },
    { type: 'privacy', version: privacyVersion(retention) },
  ];
}

export interface ConsentRow { type: string; version: string; withdrawn_at: number | null; agreed_at?: number }

/** 아직 받지 않은 필수 동의. 빈 배열이면 통과. 철회한 동의·옛 판의 동의는 세지 않는다. required = requiredConsents(지금 보관 기간 설정). */
export function missingConsents(rows: ConsentRow[], required: RequiredConsentItem[]): RequiredConsent[] {
  return required
    .filter((r) => !rows.some((x) => x.type === r.type && x.version === r.version && x.withdrawn_at === null))
    .map((r) => r.type);
}

/** 동의 없이도 열 수 있는 주소 (앞부분 일치). */
const EXEMPT_PREFIXES = ['/consent', '/terms', '/privacy', '/logout', '/login', '/lang/', '/my/account', '/api/health'];

export function consentExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** 동의 화면으로 보내야 하는가: 로그인했고, 관리자가 아니고, 예외 주소가 아닐 때만 동의 여부를 본다. */
export function needsConsentCheck(role: string | null, path: string): boolean {
  return role !== null && role !== 'admin' && !consentExempt(path);
}

/** 동의 폼: 두 항목 모두 체크해야 한다. */
export function readConsentForm(f: Record<string, unknown>): { ok: true } | { ok: false; missing: RequiredConsent[] } {
  const on = (v: unknown) => v === '1' || v === 'on';
  const missing = REQUIRED_CONSENT_TYPES.filter((t) => !on(f[t]));
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** 로그인 뒤 돌아갈 주소: 사이트 안의 경로만 받는다 (오픈 리다이렉트 방지). */
export function safeNext(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') && !consentExempt(raw) ? raw : '/my';
}
