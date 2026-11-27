// 기업·관리자 쪽에서 지원서를 다루는 문장 (T-09). 구직자 본인 쪽은 db/applications.ts.
// 여기 함수는 "누가 볼 수 있는가" 를 판단하지 않는다 — 판단은 authz.canViewApplication, 여는 길은 lib/applicants.openApplication 하나다.
// 목록 함수는 개인정보(지원서 내용)를 돌려주지 않는다: 암호문(resume_snapshot)은 getApplicationWithJob 만 읽는다.
//
// [sqlite] batch = 한 트랜잭션, changes = rowCount. file_r2_key IS NOT NULL 을 0/1 로 돌려준다 (PostgreSQL 은 boolean → 호출부 비교 수정).
import type { Db } from './types';

/** 지원자 목록의 한 줄. 이름·연락처 같은 내용은 없다 (열어야 보인다). */
export interface ApplicantListRow {
  id: string;
  status: string;
  created_at: number;
  status_changed_at: number;
  cross_border_consent_at: number | null;
  has_file: number;
}

/** 한 공고의 지원 목록 (지원한 순서). 취소된 지원도 줄은 나오지만 내용은 이미 지워져 있고 열 수 없다. */
export async function listJobApplications(db: Db, jobId: string): Promise<ApplicantListRow[]> {
  const r = await db.prepare(
    `SELECT id, status, created_at, status_changed_at, cross_border_consent_at,
            CASE WHEN file_r2_key IS NOT NULL THEN 1 ELSE 0 END AS has_file
     FROM applications WHERE job_id = ? ORDER BY created_at, id LIMIT 500`,
  ).bind(jobId).all<ApplicantListRow>();
  return r.results;
}

/** 기업의 공고별 지원 수: 전체(취소 제외) / 아직 열지 않은 것. 공고 목록의 숫자 표시에 쓴다. */
export async function countApplicationsByJob(db: Db, companyId: string): Promise<Record<string, { total: number; unread: number }>> {
  const r = await db.prepare(
    `SELECT a.job_id AS job_id,
            SUM(CASE WHEN a.status != 'withdrawn' THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS unread
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE j.company_id = ? AND j.agency_id IS NULL GROUP BY a.job_id`,
  ).bind(companyId).all<{ job_id: string; total: number; unread: number }>();
  const out: Record<string, { total: number; unread: number }> = {};
  for (const x of r.results) out[x.job_id] = { total: Number(x.total), unread: Number(x.unread) };
  return out;
}

/** 지원 한 건 + 그 공고의 소속 정보. 권한 판단에 필요한 값과 암호문을 함께 돌려준다 — 호출부는 반드시 openApplication 을 거친다. */
export interface ApplicationWithJob {
  id: string;
  job_id: string;
  seeker_id: string;
  resume_snapshot: string;      // 🔒 암호문 ('' = 취소되어 삭제됨)
  file_r2_key: string | null;
  cross_border_consent_at: number | null;
  status: string;
  status_changed_at: number;
  created_at: number;
  company_id: string;
  agency_id: string | null;
  job_created_by: string;
  job_title_ko: string | null;
}

export async function getApplicationWithJob(db: Db, id: string): Promise<ApplicationWithJob | null> {
  return db.prepare(
    `SELECT a.id, a.job_id, a.seeker_id, a.resume_snapshot, a.file_r2_key, a.cross_border_consent_at, a.status, a.status_changed_at, a.created_at,
            j.company_id, j.agency_id, j.created_by AS job_created_by, j.title_ko AS job_title_ko
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
  ).bind(id).first<ApplicationWithJob>();
}

/**
 * 기업이 지원서를 열었다는 이벤트를 남기고 상태를 옮긴다 (규칙 3: 상태는 이벤트로만 바뀐다).
 * 상태가 from 일 때만 실행된다. to 는 호출부가 rules.nextStatus(from, 'viewed') 로 계산한 값이다.
 */
export async function markViewed(db: Db, v: { id: string; actorId: string; from: string; to: string; ts: number }): Promise<boolean> {
  const res = await db.batch([
    db.prepare(
      `INSERT INTO application_events (id, application_id, event, actor_id, at)
       SELECT ?, id, 'viewed', ?, ? FROM applications WHERE id = ? AND status = ?`,
    ).bind(crypto.randomUUID(), v.actorId, v.ts, v.id, v.from),
    db.prepare('UPDATE applications SET status = ?, status_changed_at = ? WHERE id = ? AND status = ?').bind(v.to, v.ts, v.id, v.from),
  ]);
  return res[1]?.meta.changes === 1;
}

/** 이 지원에 그 이벤트가 몇 번 있었는가 (면접 요청 메일 횟수 제한에 쓴다). */
export async function countEvents(db: Db, applicationId: string, event: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND event = ?').bind(applicationId, event).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * 기업이 메일을 보냈다는 이벤트('interview_mail' · 'reject_mail')를 남기고 상태를 옮긴다 (규칙 3).
 * 상태가 from 이고 같은 이벤트가 maxSame 번 미만일 때만 이벤트가 들어간다. to 는 호출부가 rules.nextStatus 로 계산한 값이며,
 * from 과 같으면(이미 그 상태) 이벤트만 남는다. 이벤트가 들어갔으면 true.
 */
export async function recordMailEvent(
  db: Db, m: { id: string; actorId: string; event: 'interview_mail' | 'reject_mail'; from: string; to: string; maxSame: number; ts: number },
): Promise<boolean> {
  const eventId = crypto.randomUUID();
  const res = await db.batch([
    db.prepare(
      `INSERT INTO application_events (id, application_id, event, actor_id, at)
       SELECT ?, a.id, ?, ?, ? FROM applications a
       WHERE a.id = ? AND a.status = ?
         AND (SELECT COUNT(*) FROM application_events e WHERE e.application_id = a.id AND e.event = ?) < ?`,
    ).bind(eventId, m.event, m.actorId, m.ts, m.id, m.from, m.event, m.maxSame),
    // 방금 넣은 이벤트가 있을 때만 상태를 옮긴다 (이벤트 없이 상태만 바뀌는 일이 없게).
    db.prepare(
      `UPDATE applications SET status = ?, status_changed_at = ?
       WHERE id = ? AND status = ? AND status != ? AND EXISTS (SELECT 1 FROM application_events WHERE id = ?)`,
    ).bind(m.to, m.ts, m.id, m.from, m.to, eventId),
  ]);
  return res[0]?.meta.changes === 1;
}

export interface AccessLogRow {
  id: string;
  actor_id: string;
  actor_role: string;
  actor_email: string | null;
  target_type: string;
  target_id: string;
  reason: string | null;
  at: number;
}

/**
 * 열람 기록 (관리자 화면). 최근 순, before(시각) 이전 것부터 limit 개.
 * [pg] 같은 값을 두 번 바인딩하는 선택 조건: null 이면 형을 정할 수 없어 `CAST(? AS BIGINT)`·`CAST(? AS TEXT)` 로 적는다 (T-19).
 */
export async function listAccessLog(db: Db, q: { limit: number; before?: number | null; targetType?: string | null }): Promise<AccessLogRow[]> {
  const r = await db.prepare(
    `SELECT l.id, l.actor_id, l.actor_role, u.email AS actor_email, l.target_type, l.target_id, l.reason, l.at
     FROM access_log l LEFT JOIN users u ON u.id = l.actor_id
     WHERE (CAST(? AS BIGINT) IS NULL OR l.at < ?) AND (CAST(? AS TEXT) IS NULL OR l.target_type = ?)
     ORDER BY l.at DESC, l.id LIMIT ?`,
  ).bind(q.before ?? null, q.before ?? null, q.targetType ?? null, q.targetType ?? null, q.limit).all<AccessLogRow>();
  return r.results;
}

/** 내 지원서를 누가 언제 열었는지 (구직자 화면). 사유·열람자 주소는 돌려주지 않는다 — 역할과 시각만. */
export async function listViewsOfApplication(db: Db, applicationId: string, excludeActorId: string): Promise<Array<{ actor_role: string; at: number }>> {
  const r = await db.prepare(
    `SELECT actor_role, at FROM access_log WHERE target_type = 'application' AND target_id = ? AND actor_id != ? ORDER BY at DESC LIMIT 50`,
  ).bind(applicationId, excludeActorId).all<{ actor_role: string; at: number }>();
  return r.results;
}
