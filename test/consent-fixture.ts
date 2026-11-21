// 테스트용: 로그인시키는 테스트 사용자에게 지금 판의 필수 동의(이용약관·개인정보)를 넣는다.
// T-11 의 동의 확인(src/index.tsx)은 동의가 없는 회원을 /consent 로 보내므로, 동의와 상관없는 화면을 시험하는 라우트 테스트는 이것을 쓴다.
// 관리자는 동의 확인 대상이 아니지만 넣어도 해가 없다. 같은 사용자에게 두 번 불러도 한 벌만 남는다.
import { REQUIRED_CONSENTS } from '../src/lib/consent';

interface Raw { prepare(s: string): { run(...a: unknown[]): unknown } }

export function agreeRequired(raw: Raw, userId: string): void {
  for (const r of REQUIRED_CONSENTS) {
    raw.prepare(
      `INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at)
       SELECT ?, ?, ?, ?, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ? AND type = ? AND version = ? AND withdrawn_at IS NULL)`,
    ).run(`fixture-${userId}-${r.type}`, userId, r.type, r.version, userId, r.type, r.version);
  }
}
