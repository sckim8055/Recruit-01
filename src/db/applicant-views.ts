// 기업 지원자 목록 화면(/biz/jobs/:id/applicants)에서만 쓰는 읽기 (T-09b). 판단은 하지 않는다.
// 지원서 내용(resume_snapshot)·메일 글은 읽지 않는다 — 이벤트 개수만.
//
// [sqlite] COUNT(*) 가 숫자로 온다 (PostgreSQL 은 bigint → 문자열일 수 있어 Number() 로 바꾼다).
import type { Db } from './types';

/** 한 공고의 지원별 면접 요청 메일 수 (한 번의 묶음 조회). 보낸 적이 없는 지원은 들어 있지 않다. */
export async function countInterviewMailsByJob(db: Db, jobId: string): Promise<Record<string, number>> {
  const r = await db.prepare(
    `SELECT e.application_id AS id, COUNT(*) AS n
     FROM application_events e JOIN applications a ON a.id = e.application_id
     WHERE a.job_id = ? AND e.event = 'interview_mail' GROUP BY e.application_id`,
  ).bind(jobId).all<{ id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const x of r.results) out[x.id] = Number(x.n);
  return out;
}
