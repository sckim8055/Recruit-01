// PostgreSQL 권고 잠금(advisory lock) (T-19). 예약 작업이 두 프로세스(서버 두 개, 서버 + npm run maint)에서 동시에 돌지 않게 한다.
// 세션 잠금이라 연결 하나를 잡고 있는 동안만 유지된다 — 프로세스가 죽으면 연결이 끊기며 잠금도 풀린다.
import type { PoolLike } from './pg';

/** 예약 작업 잠금 번호 ('recr' + 1). 다른 프로그램과 겹치지 않을 임의의 수. */
export const MAINT_LOCK_KEY = 0x7265_6301;
/** 자동 백업 잠금 번호. */
export const BACKUP_LOCK_KEY = 0x7265_6302;

export type LockResult<T> = { acquired: false } | { acquired: true; value: T };

/** 잠금을 얻으면 fn 을 실행하고 풀어 준다. 이미 누가 잡고 있으면 기다리지 않고 { acquired: false }. */
export async function withAdvisoryLock<T>(pool: PoolLike, key: number, fn: () => Promise<T>): Promise<LockResult<T>> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [key]);
    if (r.rows[0]?.ok !== true) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      } catch (e) {
        broken = e instanceof Error ? e : new Error('unlock failed'); // 연결을 버리면 잠금도 풀린다
      }
    }
  } finally {
    client.release(broken);
  }
}
