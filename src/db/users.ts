// users 테이블. 판단은 하지 않는다 — 호출부(lib/auth.ts, lib/admin2fa.ts)가 정한 값을 그대로 쓴다.
import type { SessionUser } from '../env';

export type UserLoginRow = SessionUser & { status: string };

/** 로그인할 때 이메일로 회원을 찾는다 (lib/auth.ts verifyCode). */
export async function findUserByEmail(db: D1Database, email: string): Promise<UserLoginRow | null> {
  return db.prepare('SELECT id, email, role, locale, status FROM users WHERE email = ?')
    .bind(email).first<UserLoginRow>();
}

/** 새 회원. 값과 순서는 호출부가 정한다 (admin 은 여기서 만들어지지 않는다 — 호출부의 타입이 막는다). */
export async function insertUser(
  db: D1Database, id: string, email: string, role: string, locale: string, status: string, createdAt: number, lastLoginAt: number,
): Promise<void> {
  await db.prepare('INSERT INTO users (id, email, role, locale, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, email, role, locale, status, createdAt, lastLoginAt).run();
}

export async function touchUserLogin(db: D1Database, ts: number, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(ts, userId).run();
}

/**
 * TOTP 통과: 비밀키 확정·사용한 시간 단계 기록과 대기 상태 삭제를 한 번에 (lib/admin2fa.ts completeTotp).
 * [sqlite] D1 batch = 암묵적 트랜잭션. PostgreSQL 에서는 BEGIN … COMMIT 으로 두 문장을 묶는다.
 */
export async function confirmTotp(db: D1Database, encSecret: string, step: number, userId: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?').bind(encSecret, step, userId),
    db.prepare('DELETE FROM admin_totp_pending WHERE user_id = ?').bind(userId),
  ]);
}
