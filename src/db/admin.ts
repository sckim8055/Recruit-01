// 관리자 첫 화면의 처리할 일 개수. 개수만 읽고 개인정보는 읽지 않는다.

export interface AdminCounts { companies: number; agencies: number; jobReviews: number; reports: number }

/**
 * [sqlite] 읽기 네 개를 batch 로 보낸다 — PostgreSQL 에서는 네 번 조회(또는 한 문장의 스칼라 서브쿼리 넷)로 바꾼다.
 * [sqlite] COUNT(*) 는 SQLite 에서 숫자로 온다. PostgreSQL(node-postgres 등)에서는 bigint 라 문자열로 올 수 있다 — `::int` 로 바꾸거나 변환한다 (확인 필요).
 */
export async function adminCounts(db: D1Database): Promise<AdminCounts> {
  const [co, ag, jr, rp] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM companies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM agencies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE review_flag IS NOT NULL AND review_cleared_by IS NULL AND status IN ('draft','published')"),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results[0]?.n ?? 0;
  return { companies: n(co), agencies: n(ag), jobReviews: n(jr), reports: n(rp) };
}
