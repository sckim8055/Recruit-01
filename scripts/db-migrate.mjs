// DB 마이그레이션 적용 (T-19).  npm run db:migrate   (= node --env-file=.env scripts/db-migrate.mjs)
// 서비스 관리 프로그램의 "시작 전 명령" 으로 서버를 켤 때마다 돌린다 — 이미 적용한 파일은 건너뛰므로 여러 번 돌려도 된다.
//
// - migrations/pg/*.sql 을 번호 순서대로, 파일 하나 = 트랜잭션 하나로 적용하고 schema_migrations 에 (이름, 지문, 시각) 을 남긴다.
//   실패하면 그 파일은 통째로 되돌려지고 앞 파일까지만 적용된 채로 멈춘다 (종료 코드 1 → 서버를 켜지 않는다).
// - 이미 적용한 파일의 내용이 바뀌었으면 멈춘다 (CLAUDE.md: 기존 마이그레이션 파일은 고치지 않는다 — 새 번호 파일을 더한다).
// - 두 사람이 동시에 돌려도 PostgreSQL 권고 잠금으로 차례가 된다.
// 예전 SQLite/D1 파일(migrations/*.sql)은 기록으로만 남아 있고 여기서 쓰지 않는다 (migrations/README.md).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, fail } from './lib/cli.mjs';
import { checksum, connect } from './lib/pg-cli.mjs';

export const MIGRATIONS_DIR = join(ROOT, 'migrations', 'pg');
// src/db/system.ts 의 SCHEMA_MIGRATIONS_DDL 과 같다 (test/pg-schema.test.ts 가 비교).
export const SCHEMA_MIGRATIONS_DDL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT COLLATE "C" PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)';
const LOCK = 0x7265_6300;

export const migrationFiles = (dir = MIGRATIONS_DIR) => readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();

/** 적용한다. 돌려주는 값: { applied: [이름], skipped: n }. 문제가 있으면 예외(한국어). client 는 pg.Client. */
export async function migrate(client, dir = MIGRATIONS_DIR, log = console.log) {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
  try {
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const done = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const applied = [];
    let skipped = 0;
    for (const f of migrationFiles(dir)) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const sum = await checksum(sql);
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`${f} 는 이미 적용했는데 내용이 바뀌었습니다. 적용한 파일은 고치지 않습니다 — 되돌리고 새 번호 파일을 만드세요.`);
        skipped++;
        continue;
      }
      log(`적용: ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3::bigint)', [f, sum, Math.floor(Date.now() / 1000)]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${f} 적용 실패 (되돌렸습니다): ${e?.message ?? e}`);
      }
      applied.push(f);
    }
    const unknown = [...done.keys()].filter((n) => !migrationFiles(dir).includes(n));
    if (unknown.length) log(`[!] DB 에는 있지만 이 폴더에 없는 마이그레이션: ${unknown.join(', ')} (코드가 DB 보다 예전 판일 수 있습니다)`);
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => {});
  }
}

async function main() {
  const client = await connect();
  try {
    const r = await migrate(client);
    console.log(r.applied.length ? `[OK] ${r.applied.length}개 적용, ${r.skipped}개는 이미 적용됨.` : `[OK] 새로 적용할 것이 없습니다 (${r.skipped}개 적용됨).`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
