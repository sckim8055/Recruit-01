// PostgreSQL 스키마(migrations/pg/0001_init.sql)가 예전 SQLite/D1 마이그레이션 0001~0013 을 적용한 결과와 같은지 (T-19).
// 표·컬럼(순서)·NOT NULL·기본값 유무·기본 키·외래키(ON DELETE)·유일/부분 인덱스·CHECK 개수·기본 행을 비교한다.
// 예전 쪽은 Node 내장 node:sqlite 로 migrations/*.sql 을 적용해 읽는다 (기록으로 남긴 파일이 지금도 같은 뜻인지).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { migratedDb, pgMigrationFiles } from './pg-test-db';
import { PG_MIGRATIONS, SCHEMA_MIGRATIONS_DDL } from '../src/db/system';

type Sq = { exec(s: string): void; prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[] } };
let DatabaseSync: (new (p: string) => Sq) | null = null;
try {
  DatabaseSync = ((await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Sq }).DatabaseSync;
} catch { /* node:sqlite 없음 */ }

function sqliteFinal(): Sq {
  const db = new DatabaseSync!(':memory:');
  for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  return db;
}

/**
 * SQLite 기록(0001~0013) 이후에 pg/ 새 번호 파일로 더한 컬럼 (표 → [컬럼, CHECK 수]). 비교에서는 빼고, 아래에서 따로 확인한다.
 * 0002_resume_lang (T-22): resumes.lang, applications.resume_lang — 둘 다 NOT NULL DEFAULT 'ko' CHECK ('ko','zh').
 */
const PG_ONLY: Readonly<Record<string, ReadonlyArray<readonly [string, number]>>> = {
  resumes: [['lang', 1]], applications: [['resume_lang', 1]],
};

describe.skipIf(!DatabaseSync)('PostgreSQL 스키마 = SQLite 0001~0013', () => {
  const sq = sqliteFinal();
  const { raw } = migratedDb();
  const sqTables = sq.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((r) => ({ name: String(r.name), sql: String(r.sql) }));
  const pgTables = raw.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name").all()
    .map((r) => String(r.name));

  it('표가 같다', () => expect(pgTables).toEqual(sqTables.map((t) => t.name)));

  for (const { name, sql } of sqTables) {
    it(`${name}: 컬럼(순서)·NOT NULL·기본값·기본 키·외래키·CHECK`, () => {
      const sc = sq.prepare(`PRAGMA table_info("${name}")`).all();
      const pc = raw.prepare(
        `SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
      ).all(name).filter((c) => !(PG_ONLY[name] ?? []).some(([col]) => col === c.column_name));
      expect(pc.map((c) => c.column_name)).toEqual(sc.map((c) => c.name));
      const pkCols = sc.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
      for (const c of sc) {
        const p = pc.find((x) => x.column_name === c.name)!;
        // SQLite 의 TEXT PRIMARY KEY 는 NOT NULL 을 적지 않아도 NULL 이 들어갈 수 있었지만 앱은 언제나 id 를 넣는다 → PostgreSQL 은 NOT NULL (기본 키)
        const sqNotNull = Number(c.notnull) === 1 || pkCols.includes(String(c.name));
        expect(p.is_nullable === 'NO', `${name}.${c.name} not null`).toBe(sqNotNull);
        expect(p.column_default !== null, `${name}.${c.name} default`).toBe(c.dflt_value !== null);
        const t = String(c.type).toUpperCase();
        expect(p.data_type, `${name}.${c.name} type`).toBe(t === 'INTEGER' ? 'bigint' : 'text');
      }
      const ppk = raw.prepare(
        `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = to_regclass(?) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      ).all(name).map((r) => String(r.col));
      expect(ppk).toEqual(pkCols);
      const sfk = sq.prepare(`PRAGMA foreign_key_list("${name}")`).all()
        .map((f) => `${f.from}->${f.table}.${f.to}:${String(f.on_delete).toUpperCase()}`).sort();
      const pfk = raw.prepare(
        `SELECT kcu.column_name AS col, ccu.table_name AS rt, ccu.column_name AS rc, rc.delete_rule AS del
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.constraint_name AND ccu.constraint_schema = rc.constraint_schema
         WHERE rc.constraint_schema = current_schema() AND kcu.table_name = ?`,
      ).all(name).map((f) => `${f.col}->${f.rt}.${f.rc}:${String(f.del).replace('NO ACTION', 'NO ACTION')}`).sort();
      expect(pfk).toEqual(sfk);
      const checks = (sql.match(/\bCHECK\s*\(/gi) ?? []).length;
      const pchecks = Number(raw.prepare(
        "SELECT COUNT(*) AS n FROM pg_constraint WHERE conrelid = to_regclass(?) AND contype = 'c'",
      ).get(name)!.n);
      expect(pchecks, `${name} CHECK`).toBe(checks + (PG_ONLY[name] ?? []).reduce((s, [, n]) => s + n, 0));
    });
  }

  it('이름 붙은 인덱스: 같은 이름·컬럼·유일 여부·부분 조건', () => {
    const si = sq.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()
      .map((r) => `${r.name} ${r.tbl_name} ${/UNIQUE/i.test(String(r.sql)) ? 'U' : '-'} ${/\bWHERE\b/i.test(String(r.sql)) ? 'P' : '-'}`);
    const pi = raw.prepare(
      `SELECT c.relname AS name, t.relname AS tbl, i.indisunique AS u, i.indpred IS NOT NULL AS p
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema() AND c.relname LIKE 'idx\\_%' ORDER BY c.relname`,
    ).all().map((r) => `${r.name} ${r.tbl} ${r.u ? 'U' : '-'} ${r.p ? 'P' : '-'}`);
    expect(pi).toEqual(si);
  });

  it('job_options 기본 49행이 같다 (시각 제외)', () => {
    const cols = 'kind, code, label_ko, label_zh, sort, active, updated_by';
    expect(raw.prepare(`SELECT ${cols} FROM job_options ORDER BY kind, code`).all()).toEqual(sq.prepare(`SELECT ${cols} FROM job_options ORDER BY kind, code`).all().map((r) => ({ ...r })));
  });

  it('글자 컬럼은 COLLATE "C" (SQLite BINARY 와 같은 정렬)', () => {
    const r = raw.prepare(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'text' AND table_name <> 'schema_migrations' AND collation_name IS DISTINCT FROM 'C'",
    ).get()!;
    expect(Number(r.n)).toBe(0);
    expect(raw.prepare("SELECT 'B' < 'a' AS x").get()!.x).toBe(true); // 바이트 순서 (대문자가 먼저)
  });
});

describe('pg 에만 있는 컬럼 (SQLite 기록 이후)', () => {
  const { raw } = migratedDb();
  for (const [table, cols] of Object.entries(PG_ONLY)) {
    for (const [col] of cols) {
      it(`${table}.${col}: NOT NULL, 기본값 'ko', CHECK ('ko','zh'), 마지막 컬럼`, () => {
        const c = raw.prepare(
          `SELECT is_nullable, column_default, data_type, collation_name, ordinal_position,
                  (SELECT MAX(ordinal_position) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?) AS last
           FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
        ).get(table, table, col)!;
        expect(c).toMatchObject({ is_nullable: 'NO', data_type: 'text', collation_name: 'C' });
        expect(String(c.column_default)).toContain("'ko'");
        expect(Number(c.ordinal_position)).toBe(Number(c.last));
      });
    }
  }
});

describe('마이그레이션 목록', () => {
  it('src/db/system.PG_MIGRATIONS = migrations/pg 폴더', () => expect([...PG_MIGRATIONS]).toEqual(pgMigrationFiles()));
  it('schema_migrations 정의가 실행기(scripts/db-migrate.mjs)와 같다', async () => {
    const m = await import('../scripts/db-migrate.mjs');
    expect(m.SCHEMA_MIGRATIONS_DDL).toBe(SCHEMA_MIGRATIONS_DDL);
  });
});
