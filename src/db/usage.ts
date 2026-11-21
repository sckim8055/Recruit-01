// 남용 방지 한도의 하루 횟수 (usage_counters, 0010). 한도 값·날짜 계산·어디서 쓰는지는 src/lib/quota.ts — 여기서는 받은 값으로 SQL 만 실행한다.
// 행에는 id 만 들어간다 (기업 id · 관리자 user id · 'site'). 이메일·IP 는 넣지 않는다.
//
// 되돌리기(refund)는 없다: 한도를 잡은 뒤 엔진·메일이 실패해도 그 한 번은 쓴 것으로 센다 (단순하고, 실패를 일부러 일으켜 한도를 우회할 수 없다).

export interface QuotaKey { scope: string; subject: string; day: string }

/**
 * 한도 안이면 cost 만큼 더하고 true, 더하면 한도를 넘으면 아무것도 바꾸지 않고 false. **한 문장**이라 동시에 불러도 한도를 넘지 않는다
 * (D1 은 쓰기를 차례로 한다 — 한도 - 1 에서 두 요청이 겹치면 하나만 true).
 * - 그날 첫 사용: INSERT (cost <= limit 일 때만 — SELECT … WHERE)
 * - 이미 있으면: ON CONFLICT … DO UPDATE … WHERE n + cost <= limit (조건이 거짓이면 영향 행 0)
 *
 * [sqlite] `INSERT … SELECT ?,… WHERE … ON CONFLICT (…) DO UPDATE … WHERE …` (UPSERT + 조건) 과 meta.changes.
 *   PostgreSQL 도 같은 문법이 되고 DO UPDATE 의 WHERE 가 거짓이면 rowCount 0 이다. FROM 없는 SELECT 목록의 매개변수는
 *   `$4::integer` 처럼 형을 적어야 할 수 있다 (확인 필요). 동시성: 같은 키의 UPSERT 는 행 잠금으로 차례가 되어 한도를 넘지 않는다 (확인 필요).
 */
export async function takeQuota(
  db: D1Database, x: QuotaKey & { limit: number; ts: number; cost?: number },
): Promise<boolean> {
  const cost = x.cost ?? 1;
  const res = await db.prepare(
    `INSERT INTO usage_counters (scope, subject, day, n, updated_at)
     SELECT ?, ?, ?, ?, ? WHERE ? <= ?
     ON CONFLICT (scope, subject, day) DO UPDATE SET n = usage_counters.n + excluded.n, updated_at = excluded.updated_at
       WHERE usage_counters.n + excluded.n <= ?`,
  ).bind(x.scope, x.subject, x.day, cost, x.ts, cost, x.limit, x.limit).run();
  return res.meta.changes === 1;
}

/** 그날 쓴 횟수 (행이 없으면 0). 기본 키 한 행만 읽는다. */
export async function readUsage(db: D1Database, x: QuotaKey): Promise<number> {
  const r = await db.prepare('SELECT n FROM usage_counters WHERE scope = ? AND subject = ? AND day = ?')
    .bind(x.scope, x.subject, x.day).first<{ n: number }>();
  return Number(r?.n ?? 0);
}
