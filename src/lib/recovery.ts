// 2단계 인증 복구 코드 (T-16). 인증 앱을 잃어버렸을 때 한 번씩 쓰는 코드 8개.
// - 10자, 헷갈리는 글자(0·O·1·I·L)를 뺀 31자에서 crypto.getRandomValues 로 고른다 (치우침 없게 248 이상은 버린다). 약 49.5비트.
// - 화면에는 XXXXX-XXXXX 로 묶어 보인다. 입력은 대소문자·공백·하이픈을 무시한다.
// - 저장은 해시만: sha256(SESSION_PEPPER|rc|회원 id|코드) — 세션·인증코드와 같은 방식(lib/auth.ts tokenHash)에 회원 id 를 섞는다.
//   원문은 만든 응답에 한 번만 나가고 로그·메일·DB 어디에도 남지 않는다.
import { sha256Hex } from './crypto';

export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_COUNT = 8;
export const RECOVERY_LEN = 10;

export function newRecoveryCodes(n = RECOVERY_COUNT): string[] {
  const out: string[] = [];
  const buf = new Uint8Array(32);
  const limit = 256 - (256 % RECOVERY_ALPHABET.length); // 248
  while (out.length < n) {
    let code = '';
    while (code.length < RECOVERY_LEN) {
      crypto.getRandomValues(buf);
      for (const b of buf) {
        if (b < limit && code.length < RECOVERY_LEN) code += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
      }
    }
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** 화면 표시용 XXXXX-XXXXX. */
export const formatRecoveryCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

/** 입력 정규화: 대문자, 공백·하이픈 제거. 복구 코드 모양(10자, 알파벳 안)이 아니면 null. */
export function normalizeRecoveryCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== RECOVERY_LEN) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

export const recoveryHash = (pepper: string, userId: string, code: string): Promise<string> => sha256Hex(`${pepper}|rc|${userId}|${code}`);

/** 2단계 입력 칸 하나에 인증 앱 번호(6자리)와 복구 코드를 함께 받는다. */
export type SecondFactor = { kind: 'totp'; code: string } | { kind: 'recovery'; code: string } | { kind: 'bad' };

export function parseSecondFactor(raw: unknown): SecondFactor {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const digits = s.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) return { kind: 'totp', code: digits };
  const rc = normalizeRecoveryCode(s);
  return rc ? { kind: 'recovery', code: rc } : { kind: 'bad' };
}
