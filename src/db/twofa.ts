// 2단계 인증(T-16): 등록·재등록 대기(totp_enrolments), 복구 코드(totp_recovery_codes), 회원별 시도 수(users.totp_fail_*),
// 끄기·관리자 초기화(admin_actions). 판단·TTL·횟수는 lib/twofa.ts 에 있다. 여기는 받은 값으로 SQL 만 실행한다.
//
// [sqlite] batch = 한 트랜잭션. 판단은 첫 문장의 영향 행 수이고, 뒤 문장은 "첫 문장이 바꾼 결과가 지금 있는가" 를 EXISTS 로 다시 확인한다
// (account.eraseUser·applications.withdrawApplication 과 같은 방식). PostgreSQL 에서는 BEGIN … COMMIT, 문장 순서를 바꾸지 않는다.
import type { Db } from './types';

export interface TwofaUserRow {
  id: string; email: string; role: string; locale: 'ko' | 'zh'; status: string;
  totp_secret: string | null; totp_last_step: number | null; totp_enabled_at: number | null;
}

export async function getTwofaUser(db: Db, userId: string): Promise<TwofaUserRow | null> {
  return db.prepare(
    'SELECT id, email, role, locale, status, totp_secret, totp_last_step, totp_enabled_at FROM users WHERE id = ?',
  ).bind(userId).first<TwofaUserRow>();
}

/** 관리자 초기화 화면: 이메일로 회원 찾기 (탈퇴한 계정은 이메일이 바뀌어 있어 나오지 않는다). */
export async function findTwofaUserByEmail(db: Db, email: string): Promise<TwofaUserRow | null> {
  return db.prepare(
    'SELECT id, email, role, locale, status, totp_secret, totp_last_step, totp_enabled_at FROM users WHERE email = ?',
  ).bind(email).first<TwofaUserRow>();
}

// ── 회원별 시도 수 (로그인한 상태의 확인: 끄기·재등록 1단계·복구 코드 새로 만들기)

/**
 * 시도 하나를 잡는다. 이번 창(windowStart 이후 시작)에서 max 번을 이미 잡았으면 false (잠김). 창이 지났으면 1 부터 새로 센다.
 * 확인·더하기가 한 문장이라 동시에 들어와도 max 를 넘지 않는다. 성공하면 호출부가 clearTotpTries 로 되돌린다 → 결과적으로 "실패 수".
 */
export async function takeTotpTry(db: Db, userId: string, ts: number, windowStart: number, max: number): Promise<boolean> {
  const fresh = '(totp_fail_since IS NULL OR totp_fail_since <= ?)';
  const r = await db.prepare(
    `UPDATE users SET
       totp_fail_count = CASE WHEN ${fresh} THEN 1 ELSE totp_fail_count + 1 END,
       totp_fail_since = CASE WHEN ${fresh} THEN ? ELSE totp_fail_since END
     WHERE id = ? AND (${fresh} OR totp_fail_count < ?)`,
  ).bind(windowStart, windowStart, ts, userId, windowStart, max).run();
  return r.meta.changes === 1;
}

export async function clearTotpTries(db: Db, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET totp_fail_count = 0, totp_fail_since = NULL WHERE id = ?').bind(userId).run();
}

// ── 복구 코드

/** 복구 코드 하나를 쓴다. 아직 쓰지 않은 같은 해시가 있을 때만 → true. 한 문장이라 두 요청이 같은 코드를 동시에 써도 하나만 true. */
export async function useRecoveryCode(db: Db, userId: string, codeHash: string, ts: number): Promise<boolean> {
  const r = await db.prepare(
    'UPDATE totp_recovery_codes SET used_at = ? WHERE id IN (SELECT id FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1)',
  ).bind(ts, userId, codeHash).run();
  return r.meta.changes === 1;
}

export async function countUnusedRecoveryCodes(db: Db, userId: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(userId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export interface NewCode { id: string; hash: string }

const codeInserts = (db: Db, userId: string, codes: NewCode[], ts: number, guard: string, guardBinds: unknown[]) =>
  codes.map((c) => db.prepare(
    `INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) SELECT ?, ?, ?, NULL, ? WHERE ${guard}`,
  ).bind(c.id, userId, c.hash, ts, ...guardBinds));

/** 복구 코드 새로 만들기: 그 비밀키가 그대로일 때만 예전 코드를 모두 지우고 새 코드를 넣는다. 넣었으면 true. */
export async function replaceRecoveryCodes(db: Db, userId: string, encSecret: string, codes: NewCode[], ts: number): Promise<boolean> {
  const guard = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND totp_secret = ?)';
  const res = await db.batch([
    db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id = ? AND ${guard}`).bind(userId, userId, encSecret),
    ...codeInserts(db, userId, codes, ts, guard, [userId, encSecret]),
  ]);
  return (res[1]?.meta.changes ?? 0) === 1;
}

// ── 등록·재등록 대기 (회원 + 세션에 묶임)

export interface EnrolmentRow { id: string; secret_new: string; attempts: number; expires_at: number }

export async function findEnrolment(db: Db, userId: string, sessionId: string): Promise<EnrolmentRow | null> {
  return db.prepare('SELECT id, secret_new, attempts, expires_at FROM totp_enrolments WHERE user_id = ? AND session_id = ?')
    .bind(userId, sessionId).first<EnrolmentRow>();
}

/** 이 세션의 예전 대기와 그 회원의 만료된 대기를 지우고 새 대기를 넣는다. */
export async function insertEnrolment(
  db: Db, x: { id: string; userId: string; sessionId: string; encSecret: string; expiresAt: number; ts: number },
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM totp_enrolments WHERE session_id = ? OR (user_id = ? AND expires_at < ?)').bind(x.sessionId, x.userId, x.ts),
    db.prepare('INSERT INTO totp_enrolments (id, user_id, session_id, secret_new, attempts, expires_at) VALUES (?,?,?,?,0,?)')
      .bind(x.id, x.userId, x.sessionId, x.encSecret, x.expiresAt),
  ]);
}

export async function incEnrolmentAttempts(db: Db, id: string): Promise<void> {
  await db.prepare('UPDATE totp_enrolments SET attempts = attempts + 1 WHERE id = ?').bind(id).run();
}

export async function deleteEnrolment(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM totp_enrolments WHERE id = ?').bind(id).run();
}

/**
 * 등록·재등록 확정 (한 트랜잭션). oldSecret = 대기를 만들 때 계정의 비밀키(처음 켜는 것이면 null) — 그사이 바뀌었으면(끄기·초기화·다른 재등록) 아무것도 하지 않는다.
 * 1) 비밀키 교체 + 쓴 시간 단계 + 켠 시각(처음일 때만) + 시도 수 초기화 — 이 대기가 아직 있을 때만. 판단은 이 문장의 영향 행 수.
 * 2) 예전 복구 코드 삭제 → 3) 새 복구 코드 → 4) 지금 세션 mfa = 1 → 5) 다른 세션 모두 삭제(그 세션의 대기도 CASCADE 로) → 6) 이 회원의 대기 모두 삭제 → 7) 로그인 2단계 대기 삭제.
 */
export async function saveEnrolment(db: Db, x: {
  userId: string; sessionId: string; enrolmentId: string; oldSecret: string | null; newSecret: string; step: number; ts: number; codes: NewCode[];
}): Promise<boolean> {
  const same = x.oldSecret === null ? 'totp_secret IS NULL' : 'totp_secret = ?';
  const mine = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND totp_secret = ?)';
  const g = [x.userId, x.newSecret];
  const res = await db.batch([
    db.prepare(
      `UPDATE users SET totp_secret = ?, totp_last_step = ?, totp_enabled_at = COALESCE(totp_enabled_at, ?), totp_fail_count = 0, totp_fail_since = NULL
       WHERE id = ? AND ${same} AND EXISTS (SELECT 1 FROM totp_enrolments WHERE id = ? AND user_id = ? AND session_id = ?)`,
    ).bind(x.newSecret, x.step, x.ts, x.userId, ...(x.oldSecret === null ? [] : [x.oldSecret]), x.enrolmentId, x.userId, x.sessionId),
    db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id = ? AND ${mine}`).bind(x.userId, ...g),
    ...codeInserts(db, x.userId, x.codes, x.ts, mine, g),
    db.prepare(`UPDATE sessions SET mfa = 1 WHERE id = ? AND user_id = ? AND ${mine}`).bind(x.sessionId, x.userId, ...g),
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ? AND ${mine}`).bind(x.userId, x.sessionId, ...g),
    db.prepare(`DELETE FROM totp_enrolments WHERE user_id = ? AND ${mine}`).bind(x.userId, ...g),
    db.prepare(`DELETE FROM admin_totp_pending WHERE user_id = ? AND ${mine}`).bind(x.userId, ...g),
  ]);
  return res[0]?.meta.changes === 1;
}

/**
 * 회원이 스스로 끄기. 관리자는 끌 수 없다(`role != 'admin'` — 호출부도 막지만 문장에서도). 그 비밀키가 그대로일 때만.
 * 비밀키·쓴 단계·켠 시각 → NULL, 복구 코드·대기·로그인 2단계 대기 삭제. 세션은 그대로 둔다.
 */
export async function disableTotp(db: Db, userId: string, encSecret: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare(
      `UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_enabled_at = NULL, totp_fail_count = 0, totp_fail_since = NULL
       WHERE id = ? AND role != 'admin' AND totp_secret = ?`,
    ).bind(userId, encSecret),
    ...clearRows(db, userId, 'EXISTS (SELECT 1 FROM users WHERE id = ? AND totp_secret IS NULL)', [userId]),
  ]);
  return res[0]?.meta.changes === 1;
}

const clearRows = (db: Db, userId: string, guard: string, binds: unknown[]) => [
  db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id = ? AND ${guard}`).bind(userId, ...binds),
  db.prepare(`DELETE FROM totp_enrolments WHERE user_id = ? AND ${guard}`).bind(userId, ...binds),
  db.prepare(`DELETE FROM admin_totp_pending WHERE user_id = ? AND ${guard}`).bind(userId, ...binds),
];

/**
 * 관리자가 회원의 2단계 인증을 초기화 (한 트랜잭션). 대상이 관리자가 아니고, 탈퇴하지 않았고, 2단계 인증이 켜져 있을 때만.
 * 1) 기록(admin_actions) — 판단은 이 문장의 영향 행 수 → 2) 비밀키 등 NULL → 3) 복구 코드·대기·로그인 2단계 대기 → 4) 세션 모두 삭제.
 * 뒤 문장은 모두 "방금 넣은 기록이 있는가" 로 확인한다.
 */
export async function resetMemberTotp(db: Db, x: { actionId: string; actorId: string; targetId: string; reason: string; ts: number }): Promise<boolean> {
  const done = 'EXISTS (SELECT 1 FROM admin_actions WHERE id = ?)';
  const res = await db.batch([
    db.prepare(
      `INSERT INTO admin_actions (id, actor_id, action, target_user_id, reason, at)
       SELECT ?, ?, 'totp_reset', ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM users WHERE id = ? AND role != 'admin' AND status != 'deleted' AND totp_secret IS NOT NULL)`,
    ).bind(x.actionId, x.actorId, x.targetId, x.reason, x.ts, x.targetId),
    db.prepare(
      `UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_enabled_at = NULL, totp_fail_count = 0, totp_fail_since = NULL
       WHERE id = ? AND role != 'admin' AND ${done}`,
    ).bind(x.targetId, x.actionId),
    ...clearRows(db, x.targetId, done, [x.actionId]),
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${done}`).bind(x.targetId, x.actionId),
  ]);
  return res[0]?.meta.changes === 1;
}
