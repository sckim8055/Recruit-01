// 구직자 지원 현황 화면(/my/applications)에서만 쓰는 읽기. 판단은 하지 않는다.
// 공개 조건은 db/public-jobs.publicJobWhere 를 그대로 쓴다 (조건을 여기서 새로 만들지 않는다).
// 지원서 내용(resume_snapshot)은 읽지 않는다.
import type { Flags } from '../env';
import { publicJobWhere } from './public-jobs';
import type { Db } from './types';

/**
 * 내가 지원한 공고 중 지금도 공개 목록에 보이는 공고의 id. 목록에서 공고 제목을 링크로 보일지 정하는 데만 쓴다
 * (보이지 않는 공고는 링크 없이 제목만 — 눌러도 404 이므로).
 * 바인딩은 seeker_id + 공개 조건 값뿐이라 지원 수와 관계없이 매개변수 개수가 일정하다.
 */
export async function listVisibleAppliedJobIds(db: Db, seekerId: string, flags: Flags, now: number): Promise<string[]> {
  const vis = publicJobWhere(flags, now);
  const r = await db.prepare(
    `SELECT a.job_id FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
     WHERE a.seeker_id = ? AND ${vis.sql}`,
  ).bind(seekerId, ...vis.binds).all<{ job_id: string }>();
  return r.results.map((x) => x.job_id);
}
