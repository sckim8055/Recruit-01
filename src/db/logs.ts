// 열람 기록(access_log)과 메일 발송 기록(email_log). 값은 호출부(lib/files.ts, lib/email.ts)가 정한다.
// 개인정보 원문을 넣지 않는다: email_log 에는 주소의 해시만, access_log 에는 id 와 사유만.
import type { Db } from './types';

export async function insertAccessLog(
  db: Db, id: string, actorId: string, actorRole: string, targetType: string, targetId: string, reason: string | null, at: number,
): Promise<void> {
  await db.prepare('INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, actorId, actorRole, targetType, targetId, reason, at).run();
}

export async function insertEmailLog(db: Db, id: string, toHash: string, template: string, result: string, sentAt: number): Promise<void> {
  await db.prepare('INSERT INTO email_log (id, to_hash, template, result, sent_at) VALUES (?,?,?,?,?)')
    .bind(id, toHash, template, result, sentAt)
    .run();
}
