// 시스템 점검용 읽기 (T-19, /admin/system): DB 연결, 적용된 마이그레이션. 개인정보를 읽지 않는다.
import type { Db } from './types';

/** migrations/pg/ 의 파일 이름 (번호 순서). 새 파일을 더하면 여기에도 적는다 — test/pg-schema.test.ts 가 폴더와 같은지 본다. */
export const PG_MIGRATIONS: readonly string[] = ['0001_init.sql'];

/** 적용 기록 표. scripts/db-migrate.mjs 가 만들고 채운다 (같은 정의가 그 파일에도 있다). */
export const SCHEMA_MIGRATIONS_DDL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT COLLATE "C" PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)';

/** DB 에 붙는지. 붙으면 true (예외를 밖으로 내보내지 않는다). */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    const r = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return Number(r?.ok) === 1;
  } catch {
    return false;
  }
}

/** 적용된 마이그레이션 이름. 기록 표가 없거나 읽지 못하면 null. */
export async function listAppliedMigrations(db: Db): Promise<string[] | null> {
  try {
    const r = await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all<{ name: string }>();
    return r.results.map((x) => x.name);
  } catch {
    return null;
  }
}
