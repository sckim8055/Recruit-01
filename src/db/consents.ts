// 동의 기록 (consents). 이용약관·개인정보(type terms/privacy)는 여기서, 국외 이전(cross_border)은 db/applications.ts 에서 쓴다.
// [sqlite] batch = 한 트랜잭션. INSERT … SELECT … WHERE NOT EXISTS 로 같은 판의 동의가 두 줄 생기지 않게 한다.
import type { ConsentRow } from '../lib/consent';

/** 그 회원의 terms·privacy 동의 (철회 여부 포함). 요청마다 한 번 읽는다 — idx_consents_user(user_id, type). */
export async function listRequiredConsents(db: D1Database, userId: string): Promise<ConsentRow[]> {
  const r = await db.prepare(
    "SELECT type, version, withdrawn_at FROM consents WHERE user_id = ? AND type IN ('terms','privacy')",
  ).bind(userId).all<ConsentRow>();
  return r.results;
}

/** 동의를 남긴다. 같은 종류·같은 판의 유효한 동의가 이미 있으면 건너뛴다. */
export async function insertConsents(db: D1Database, userId: string, items: Array<{ type: string; version: string }>, ts: number): Promise<void> {
  if (!items.length) return;
  await db.batch(items.map((i) => db.prepare(
    `INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at)
     SELECT ?, ?, ?, ?, NULL, ?
     WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ? AND type = ? AND version = ? AND withdrawn_at IS NULL)`,
  ).bind(crypto.randomUUID(), userId, i.type, i.version, ts, userId, i.type, i.version)));
}
