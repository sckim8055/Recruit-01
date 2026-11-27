// 회원 탈퇴 (T-11). 한 트랜잭션으로 그 회원의 개인정보를 지우고 계정을 못 쓰게 한다.
//
// users 행 자체는 지우지 않는다: 열람 기록(access_log)·공고(jobs.created_by)·이벤트가 이 id 를 가리키고, 열람 기록은 법정 보관 대상이다.
// 대신 **이메일을 무작위 표시로 바꾸고**(개인을 알아볼 수 없게) status = 'deleted' 로 둔다. 같은 이메일로 다시 가입하면 새 계정이 된다.
//
// 지워지는 것: 이력서(행), 지원서 내용(암호문 → '')·파일 키, 프로필, 알림 조건, 세션, 인증코드, 2단계 대기·비밀값, 담당자 소속, 받은 초대.
// 남는 것: 지원했다는 사실(행·상태·이벤트, 내용 없음), 동의 기록(철회 시각을 채움), 열람 기록, 그 회원이 만든 공고(기업의 자료).
// R2 파일은 호출부(lib/account.ts)가 미리 키를 모아 두었다가 이 트랜잭션 뒤에 지운다.
//
// [pg] batch = 한 트랜잭션 (BEGIN … COMMIT). 이벤트 id 는 replace(gen_random_uuid()::text, '-', '') (하이픈 없는 32자 — 예전 SQLite 의 lower(hex(randomblob(16))) 와 같은 모양, T-19).
// [sqlite] 문장 수가 많다 — D1 은 batch 를 한 번의 왕복으로 처리한다.
import type { Db } from './types';

const ACTIVE = "('submitted','viewed','reviewing','interview')";

/** 탈퇴를 막아야 하는 경우: 다른 담당자가 있는 기업의 대표 담당자(대표를 넘길 방법이 아직 없다). 그런 기업 수를 돌려준다. */
export async function countOwnedCompaniesWithOthers(db: Db, userId: string): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM company_members m
     WHERE m.user_id = ? AND m.member_role = 'owner'
       AND EXISTS (SELECT 1 FROM company_members o WHERE o.company_id = m.company_id AND o.user_id != m.user_id)`,
  ).bind(userId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * 지운다. 계정이 활동 중(active)·정지(suspended)일 때만 실행되고, 이미 탈퇴한 계정이면 아무것도 바꾸지 않는다 → false.
 * marker: 이메일 자리에 넣을 무작위 표시 (예: deleted-<uuid>@deleted.invalid).
 */
export async function eraseUser(db: Db, u: { id: string; email: string; marker: string; ts: number }): Promise<boolean> {
  const alive = "EXISTS (SELECT 1 FROM users WHERE id = ? AND status != 'deleted')";
  const res = await db.batch([
    // 1) 진행 중인 지원: 취소 이벤트를 남긴다 (규칙 3 — 상태는 이벤트와 함께 바뀐다)
    db.prepare(
      `INSERT INTO application_events (id, application_id, event, actor_id, at)
       SELECT replace(gen_random_uuid()::text, '-', ''), id, 'withdrawn', ?, ? FROM applications WHERE seeker_id = ? AND status IN ${ACTIVE} AND ${alive}`,
    ).bind(u.id, u.ts, u.id, u.id),
    // 2) 모든 지원서의 내용을 지운다. 진행 중이던 것은 '취소' 로, 이미 끝난 것은 상태를 그대로 둔다.
    //    여러 건을 한 문장으로 바꾸므로 SQL 의 CASE 로 쓴다 — 뜻은 rules.nextStatus(s, 'withdrawn') 와 같아야 하고,
    //    ACTIVE 목록이 lib/application.WITHDRAWABLE 과 같은지는 test/account.test.ts 가 확인한다.
    db.prepare(
      `UPDATE applications SET
         status = CASE WHEN status IN ${ACTIVE} THEN 'withdrawn' ELSE status END,
         status_changed_at = CASE WHEN status IN ${ACTIVE} THEN ? ELSE status_changed_at END,
         resume_snapshot = '', file_r2_key = NULL, summary_zh = NULL, purge_after = ?
       WHERE seeker_id = ? AND ${alive}`,
    ).bind(u.ts, u.ts, u.id, u.id),
    // 3) 동의 철회 표시
    db.prepare(`UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL AND ${alive}`).bind(u.ts, u.id, u.id),
    // 4) 이력서·프로필·알림 조건
    db.prepare(`DELETE FROM resumes WHERE user_id = ? AND ${alive}`).bind(u.id, u.id),
    db.prepare(`DELETE FROM seeker_profiles WHERE user_id = ? AND ${alive}`).bind(u.id, u.id),
    db.prepare(`DELETE FROM alerts WHERE seeker_id = ? AND ${alive}`).bind(u.id, u.id),
    // 5) 기업 담당자: 혼자 맡고 있던 기업의 게재 중 공고는 마감한다 (볼 사람이 없는 공고에 지원이 쌓이지 않게)
    db.prepare(
      `UPDATE jobs SET status = 'closed', updated_at = ?
       WHERE status = 'published' AND ${alive}
         AND company_id IN (SELECT company_id FROM company_members WHERE user_id = ?)
         AND NOT EXISTS (SELECT 1 FROM company_members o WHERE o.company_id = jobs.company_id AND o.user_id != ?)`,
    ).bind(u.ts, u.id, u.id, u.id),
    db.prepare(`DELETE FROM company_members WHERE user_id = ? AND ${alive}`).bind(u.id, u.id),
    db.prepare(`DELETE FROM agency_members WHERE user_id = ? AND ${alive}`).bind(u.id, u.id),
    db.prepare(`DELETE FROM company_invites WHERE email = ? AND accepted_at IS NULL AND ${alive}`).bind(u.email, u.id),
    // 6) 로그인 수단
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM admin_totp_pending WHERE user_id = ?').bind(u.id),
    db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id = ? AND ${alive}`).bind(u.id, u.id), // 2단계 인증 복구 코드 (T-16)
    db.prepare(`DELETE FROM auth_codes WHERE email = ? AND ${alive}`).bind(u.email, u.id),
    // 7) 계정: 이메일을 무작위 표시로 바꾸고 탈퇴 상태로 (맨 마지막 — 앞 문장들의 "아직 탈퇴 전" 조건이 이 문장 전까지 참이어야 한다)
    db.prepare("UPDATE users SET email = ?, status = 'deleted', totp_secret = NULL, totp_last_step = NULL, totp_enabled_at = NULL, last_login_at = NULL WHERE id = ? AND status != 'deleted'").bind(u.marker, u.id),
  ]);
  return res[res.length - 1]?.meta.changes === 1;
}
