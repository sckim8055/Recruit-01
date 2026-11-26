// 로그인 인증코드(auth_codes), 세션(sessions), 로그인 2단계 대기(admin_totp_pending — T-16 부터 2단계 인증을 켠 회원도 쓴다, 이름은 그대로).
// TTL·횟수·판단은 lib/auth.ts, lib/twofa.ts 에 있다. 여기는 받은 값으로 SQL 만 실행한다.
import type { SessionUser } from '../env';

// ── auth_codes

export async function getAuthCodeSentAt(db: D1Database, email: string): Promise<{ last_sent_at: number } | null> {
  return db.prepare('SELECT last_sent_at FROM auth_codes WHERE email = ?').bind(email).first<{ last_sent_at: number }>();
}

/** 새 코드 저장(있으면 덮어쓰기). ON CONFLICT … DO UPDATE 와 excluded 는 PostgreSQL 에서도 같은 문법이다. */
export async function upsertAuthCode(db: D1Database, email: string, codeHash: string, expiresAt: number, lastSentAt: number): Promise<void> {
  await db.prepare(
    `INSERT INTO auth_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = excluded.last_sent_at`,
  ).bind(email, codeHash, expiresAt, lastSentAt).run();
}

export interface AuthCodeRow { code_hash: string; expires_at: number; attempts: number }

export async function getAuthCode(db: D1Database, email: string): Promise<AuthCodeRow | null> {
  return db.prepare('SELECT code_hash, expires_at, attempts FROM auth_codes WHERE email = ?')
    .bind(email).first<AuthCodeRow>();
}

export async function incAuthCodeAttempts(db: D1Database, email: string): Promise<void> {
  await db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
}

export async function deleteAuthCode(db: D1Database, email: string): Promise<void> {
  await db.prepare('DELETE FROM auth_codes WHERE email = ?').bind(email).run();
}

// ── sessions

/**
 * [sqlite] mfa 는 INTEGER 0/1 이다 (호출부가 1/0 을 넘긴다). PostgreSQL 에서 BOOLEAN 으로 바꾸면
 * 이 값과 findSessionUser 의 mfa 비교(lib/auth.ts sessionUsable: mfa === 1)를 같이 고쳐야 한다. INTEGER 로 두면 그대로 된다.
 */
export async function insertSession(db: D1Database, id: string, userId: string, createdAt: number, expiresAt: number, mfa: number): Promise<void> {
  await db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
    .bind(id, userId, createdAt, expiresAt, mfa).run();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export type SessionUserRow = SessionUser & { mfa: number; totp_on: number };

/**
 * 요청마다 세션을 읽는다 (lib/auth.ts loadUser). [sqlite] mfa INTEGER 0/1 — insertSession 주석 참고.
 * totp_on = 그 계정이 2단계 인증을 켰는가 (0/1, 비밀키 자체는 읽지 않는다).
 */
export async function findSessionUser(db: D1Database, sessionId: string, ts: number): Promise<SessionUserRow | null> {
  return db.prepare(
    `SELECT u.id, u.email, u.role, u.locale, s.mfa, CASE WHEN u.totp_secret IS NULL THEN 0 ELSE 1 END AS totp_on
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`,
  ).bind(sessionId, ts).first<SessionUserRow>();
}

// ── admin_totp_pending (로그인 2단계 대기: 관리자 + 2단계 인증을 켠 회원)

/** 이 회원의 이전 대기 상태와 만료된 대기 상태를 지운다. */
export async function deleteTotpPendingForUser(db: D1Database, userId: string, ts: number): Promise<void> {
  await db.prepare('DELETE FROM admin_totp_pending WHERE user_id = ? OR expires_at < ?').bind(userId, ts).run();
}

/** chosenRole: 로그인 화면에서 고른 유형 (2단계 뒤 유형 안내에만 쓴다). */
export async function insertTotpPending(db: D1Database, id: string, userId: string, expiresAt: number, chosenRole: string | null): Promise<void> {
  await db.prepare('INSERT INTO admin_totp_pending (id, user_id, attempts, expires_at, chosen_role) VALUES (?,?,0,?,?)')
    .bind(id, userId, expiresAt, chosenRole).run();
}

export interface TotpPendingRow {
  id: string; user_id: string; secret_new: string | null; attempts: number; expires_at: number; chosen_role: string | null;
  email: string; locale: 'ko' | 'zh'; role: string; status: string; totp_secret: string | null; totp_last_step: number | null;
}

export async function findTotpPending(db: D1Database, id: string): Promise<TotpPendingRow | null> {
  return db.prepare(
    `SELECT p.id, p.user_id, p.secret_new, p.attempts, p.expires_at, p.chosen_role,
            u.email, u.locale, u.role, u.status, u.totp_secret, u.totp_last_step
     FROM admin_totp_pending p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
  ).bind(id).first<TotpPendingRow>();
}

export async function deleteTotpPending(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM admin_totp_pending WHERE id = ?').bind(id).run();
}

/** 2단계를 통과한 대기를 지운다. 이 요청이 지웠으면 true — 같은 대기로 세션이 두 번 만들어지지 않게 (한 문장 가드). */
export async function consumeTotpPending(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM admin_totp_pending WHERE id = ?').bind(id).run();
  return r.meta.changes === 1;
}

export async function setTotpPendingSecret(db: D1Database, secretNew: string, id: string): Promise<void> {
  await db.prepare('UPDATE admin_totp_pending SET secret_new = ? WHERE id = ?').bind(secretNew, id).run();
}

export async function incTotpPendingAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE admin_totp_pending SET attempts = attempts + 1 WHERE id = ?').bind(id).run();
}
