// 테스트용 DB (T-19): PGlite(메모리 PostgreSQL 16 호환)에 migrations/pg/*.sql 을 적용하고, 서버와 **같은 어댑터**(src/db/pg.ts createDb)로 감싼다.
// 예전 test/sqlite-d1.ts(node:sqlite) 를 대신한다.
//
// - `d1`  : 앱 코드에 넘기는 Db (prepare·bind·first·all·run·batch). batch = 한 트랜잭션.
// - `raw` : 테스트가 직접 행을 넣고 확인하는 동기 도구 (exec · prepare(sql).get/all/run). SQL 의 `?` 는 앱과 같은 규칙으로 `$n` 이 된다.
// PGlite 는 비동기라서 별도 스레드(test/pg-worker.mjs)에서 돌리고, 여기서는 Atomics.wait 로 응답을 기다린다 (동기 호출).
// 한 테스트 파일에 PGlite 하나, migratedDb() 마다 새 스키마 — 서로 섞이지 않는다.
// PGlite 는 연결이 하나뿐이라 동시성(READ COMMITTED)은 시험할 수 없다 → test/pg-concurrency.test.ts 가 실제 PostgreSQL(PG_TEST_URL)로 한다.
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { readdirSync, readFileSync } from 'node:fs';
import { createDb, toPgSql, type PgBackend, type PgQueryResult } from '../src/db/pg';
import type { Db } from '../src/db/types';
import { SCHEMA_MIGRATIONS_DDL } from '../src/db/system';

export const hasDb = true;

export const pgMigrationFiles = (): string[] => readdirSync('migrations/pg').filter((f) => f.endsWith('.sql')).sort();
/** migrations/pg/*.sql 을 번호 순서대로 이은 글. */
export function pgSchemaSql(): string {
  return pgMigrationFiles().map((f) => readFileSync(`migrations/pg/${f}`, 'utf8')).join('\n');
}

interface Bridge { call(msg: Record<string, unknown>): unknown }
let bridge: Bridge | null = null;

function getBridge(): Bridge {
  if (bridge) return bridge;
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), {
    workerData: { port: port2, sab, initSql: pgSchemaSql(), migrationNames: pgMigrationFiles(), migrationsDdl: SCHEMA_MIGRATIONS_DDL },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  bridge = {
    call(msg) {
      Atomics.store(flag, 0, 0);
      port1.postMessage(msg);
      // PGlite 첫 시작은 몇 초 걸린다.
      if (Atomics.wait(flag, 0, 0, 60_000) === 'timed-out') throw new Error('pg-test-db: PGlite worker did not answer');
      const got = receiveMessageOnPort(port1);
      if (!got) throw new Error('pg-test-db: no reply');
      const r = got.message as { ok: boolean; value?: unknown; error?: { message: string; code?: string } };
      if (!r.ok) {
        const e = new Error(r.error?.message ?? 'db error') as Error & { code?: string };
        if (r.error?.code) e.code = r.error.code;
        throw e;
      }
      return r.value;
    },
  };
  return bridge;
}

let seq = 0;

export interface RawStatement {
  get(...a: unknown[]): Record<string, unknown> | undefined;
  all(...a: unknown[]): Record<string, unknown>[];
  run(...a: unknown[]): { changes: number };
}
export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}

/** 스키마를 적용한 새 DB. */
export function migratedDb(): { raw: RawDb; d1: Db; schema: string } {
  const b = getBridge();
  const schema = `t${process.pid}_${++seq}`;
  b.call({ op: 'newSchema', schema });
  const q = (text: string, params: unknown[]) => b.call({ op: 'query', schema, sql: text, params }) as PgQueryResult;
  const backend: PgBackend = {
    query: async (text, params) => q(text, params),
    batch: async (items) => (b.call({ op: 'batch', schema, items }) as { results: PgQueryResult[] }).results,
  };
  const plain = (r: Record<string, unknown>) => ({ ...r });
  const raw: RawDb = {
    exec: (sql) => { b.call({ op: 'exec', schema, sql }); },
    prepare: (sql) => {
      const go = (a: unknown[]) => { const c = toPgSql(sql, a); return q(c.text, c.params); };
      return {
        get: (...a) => { const r = go(a).rows[0]; return r ? plain(r) : undefined; },
        all: (...a) => go(a).rows.map(plain),
        run: (...a) => ({ changes: go(a).rowCount ?? 0 }),
      };
    },
  };
  return { raw, d1: createDb(backend), schema };
}
