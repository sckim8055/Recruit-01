// 테스트용 PGlite(메모리 PostgreSQL)를 별도 스레드에서 돌린다 (test/pg-test-db.ts 가 씀).
// 테스트의 `raw.prepare(…).get()` 처럼 동기 호출을 지원하려고, 요청마다 응답을 보낸 뒤 공유 메모리 신호로 기다리는 쪽을 깨운다.
// 한 테스트 파일 = 한 PGlite. migratedDb() 마다 새 스키마(t1, t2, …)를 만들어 서로 섞이지 않게 한다.
import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';

const { port, sab, initSql, migrationNames, migrationsDdl } = workerData;
const flag = new Int32Array(sab);
const toNum = (s) => Number(s);
const db = new PGlite({ parsers: { 20: toNum, 1700: toNum } });
let current = 'public';

const errOf = (e) => ({ message: e instanceof Error ? e.message : String(e), code: typeof e?.code === 'string' ? e.code : undefined });
const shape = (r) => ({ rows: r.rows ?? [], rowCount: r.affectedRows ?? 0 });

async function use(schema) {
  if (schema && schema !== current) {
    await db.exec(`SET search_path TO "${schema}"`);
    current = schema;
  }
}

let ready = false;
async function handle(m) {
  await db.waitReady;
  if (!ready) {
    // 서버와 같게 모든 트랜잭션을 SERIALIZABLE 로 (src/db/pg.ts createPool). PGlite 는 연결이 하나라 동시성 자체는 시험되지 않는다.
    await db.exec('SET default_transaction_isolation TO serializable');
    ready = true;
  }
  switch (m.op) {
    case 'newSchema': {
      await db.exec(`CREATE SCHEMA "${m.schema}"`);
      await use(m.schema);
      await db.exec(initSql);
      // scripts/db-migrate.mjs 가 남기는 적용 기록과 같게 (/admin/system 의 마이그레이션 점검)
      await db.exec(migrationsDdl);
      for (const n of migrationNames) await db.query('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, 0)', [n, 'test']);
      return { rows: [], rowCount: 0 };
    }
    case 'exec':
      await use(m.schema);
      await db.exec(m.sql);
      return { rows: [], rowCount: 0 };
    case 'query':
      await use(m.schema);
      return shape(await db.query(m.sql, m.params));
    case 'batch': {
      await use(m.schema);
      const out = [];
      await db.exec('BEGIN');
      try {
        for (const it of m.items) out.push(shape(await db.query(it.text, it.params)));
        await db.exec('COMMIT');
      } catch (e) {
        await db.exec('ROLLBACK');
        throw e;
      }
      return { results: out };
    }
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

port.on('message', async (m) => {
  let reply;
  try {
    reply = { ok: true, value: await handle(m) };
  } catch (e) {
    reply = { ok: false, error: errOf(e) };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
parentPort?.postMessage('ready');
