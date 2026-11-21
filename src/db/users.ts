// users 테이블. 판단은 하지 않는다 — 호출부(lib/auth.ts, lib/twofa.ts)가 정한 값을 그대로 쓴다.
import type { SessionUser } from '../env';

/** totp_on = 2단계 인증을 켰는가 (0/1). 비밀키 자체는 읽지 않는다. */
export type UserLoginRow = SessionUser & { status: string; totp_on: number };

/** 로그인할 때 이메일로 회원을 찾는다 (lib/auth.ts verifyCode). */
export async function findUserByEmail(db: D1Database, email: string): Promise<UserLoginRow | null> {
  return db.prepare('SELECT id, email, role, locale, status, CASE WHEN totp_secret IS NULL THEN 0 ELSE 1 END AS totp_on FROM users WHERE email = ?')
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
 * 관리자 최초 등록(로그인 2단계, lib/twofa.ts completeTotp): 비밀키 확정·사용한 시간 단계·켠 시각 + 복구 코드(해시) + 대기 상태 삭제를 한 번에.
 * 아직 비밀키가 없을 때만 (`totp_secret IS NULL`) — 판단은 첫 문장의 영향 행 수. 뒤 문장은 "방금 이 값으로 확정됨" 을 확인한다.
 * [sqlite] D1 batch = 암묵적 트랜잭션. PostgreSQL 에서는 BEGIN … COMMIT 으로 묶고 순서를 바꾸지 않는다.
 */
export async function confirmTotp(
  db: D1Database, encSecret: string, step: number, userId: string, ts: number, codes: { id: string; hash: string }[],
): Promise<boolean> {
  const mine = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND totp_secret = ?)';
  const res = await db.batch([
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ?, totp_enabled_at = ? WHERE id = ? AND totp_secret IS NULL')
      .bind(encSecret, step, ts, userId),
    db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id = ? AND ${mine}`).bind(userId, userId, encSecret),
    ...codes.map((c) => db.prepare(
      `INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) SELECT ?, ?, ?, NULL, ? WHERE ${mine}`,
    ).bind(c.id, userId, c.hash, ts, userId, encSecret)),
    db.prepare('DELETE FROM admin_totp_pending WHERE user_id = ?').bind(userId),
    // 계정 화면에서 비밀키가 없을 때 시작한 등록 대기(db/twofa.ts)는 이제 맞지 않는다 — 재등록 1단계 없이 비밀키를 바꾸지 못하게 지운다.
    db.prepare(`DELETE FROM totp_enrolments WHERE user_id = ? AND ${mine}`).bind(userId, userId, encSecret),
  ]);
  return res[0]?.meta.changes === 1;
}

/**
 * 인증 앱 번호를 썼다: 마지막 시간 단계를 올린다. 같은 비밀키이고 그 단계보다 앞선 단계만 받는다 → 같은 번호를 두 요청이 동시에 써도 하나만 true.
 * (lib/totp.verifyTotp 가 lastStep 이하를 이미 거르지만, 읽은 뒤 쓰기 전 사이의 동시 요청을 이 한 문장이 막는다.)
 */
export async function useTotpStep(db: D1Database, userId: string, encSecret: string, step: number): Promise<boolean> {
  const r = await db.prepare(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
  ).bind(step, userId, encSecret, step).run();
  return r.meta.changes === 1;
}
