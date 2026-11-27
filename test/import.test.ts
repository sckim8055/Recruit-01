// 예전 Cloudflare 테스트 서버에서 가져오기 (T-19, scripts/import-from-cloudflare.mjs).
// 가짜 D1 내보내기(test/import-fixture.ts) + 메모리 PostgreSQL(PGlite) 로: 미리 보기(아무것도 안 바뀜) · 실제 가져오기 · 다시 실행(같은 결과) ·
// 다른 ENC_KEY 로는 멈춤 · 중복 제거(같은 기본 키) · 유일 제약 충돌은 되돌림 · 파일 받기.
// 마지막 묶음은 가짜 wrangler(test/fixtures/fake-wrangler.mjs)와 실제 PostgreSQL(PG_TEST_URL)로 명령 전체를 돌린다.
// 실제 Cloudflare 계정으로는 시험하지 못했다.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  canDecryptFile, checkEncKey, fetchFiles, fileKeys, importKey, loadExport, pgTables, runImport, SKIP_TABLES, TABLE_ORDER, wranglerCommand,
  writeWranglerConfig, type Client,
} from '../scripts/import-from-cloudflare.mjs';
import { buildFixture, FAKE_KEY, IDS, OTHER_KEY, type Fixture } from './import-fixture';
import { pgSchemaSql } from './pg-test-db';
import { SCHEMA_MIGRATIONS_DDL } from '../src/db/system';
import { decryptText, importEncKey } from '../src/lib/crypto';

let fx: Fixture;
beforeAll(async () => { fx = await buildFixture(); });

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'recruit-imp-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function pgClient(): Promise<{ client: Client; db: PGlite; n: (sql: string) => Promise<number> }> {
  const db = new PGlite({ parsers: { 20: (x: string) => Number(x), 1700: (x: string) => Number(x) } });
  await db.exec(pgSchemaSql());
  await db.exec(SCHEMA_MIGRATIONS_DDL);
  const client: Client = { query: async (t, p) => { const r = await db.query(t, p ?? []); return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 }; } };
  return { client, db, n: async (sql) => Number(((await db.query(sql)).rows[0] as { n: number }).n) };
}
const quiet = () => {};

describe('가져오기: DB', () => {
  it('PostgreSQL 의 모든 표가 가져오는 순서 또는 가져오지 않는 표에 있다', async () => {
    const { client } = await pgClient();
    const all = await pgTables(client);
    expect(all.filter((t) => !TABLE_ORDER.includes(t) && !SKIP_TABLES.includes(t))).toEqual([]);
  });

  it('ENC_KEY 확인: 같은 키면 풀리고, 다른 키면 실패 수가 나온다', async () => {
    const sqlite = await loadExport(fx.sql);
    expect(await checkEncKey(sqlite, FAKE_KEY)).toMatchObject({ failed: 0 });
    expect((await checkEncKey(sqlite, FAKE_KEY)).checked).toBeGreaterThanOrEqual(3);
    const bad = await checkEncKey(sqlite, OTHER_KEY);
    expect(bad.failed).toBe(bad.checked);
    await expect(importKey('short')).rejects.toThrow();
  });

  it('미리 보기: 개수만 세고 아무것도 넣지 않는다', async () => {
    const { client, n } = await pgClient();
    const rep = await runImport({ client, sqlite: await loadExport(fx.sql), dryRun: true, log: quiet });
    expect(rep).toMatchObject({ ok: true, committed: false, conflicts: [], problems: [] });
    expect(rep.tables.find((t) => t.table === 'users')).toMatchObject({ source: 3, inserted: 3 });
    expect(await n('SELECT COUNT(*) AS n FROM users')).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM job_options WHERE code = 'semiconductor'")).toBe(0);
  });

  it('가져오기 → 다시 실행해도 같은 결과 (중복 없음), 세션·로그인 대기는 가져오지 않는다, 암호문은 그대로 풀린다', async () => {
    const { client, db, n } = await pgClient();
    const sqlite = await loadExport(fx.sql);
    const r1 = await runImport({ client, sqlite, dryRun: false, log: quiet });
    expect(r1).toMatchObject({ ok: true, committed: true });
    expect(r1.skipped.sort()).toEqual(['admin_totp_pending', 'auth_codes', 'd1_migrations', 'sessions', 'totp_enrolments']);
    for (const [t, c] of [['users', 3], ['applications', 2], ['application_events', 1], ['resumes', 1], ['verification_docs', 1], ['alert_unsub_tokens', 1], ['totp_recovery_codes', 1], ['sessions', 0], ['auth_codes', 0], ['admin_totp_pending', 0]] as const) {
      expect(await n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(c);
    }
    // job_options: 관리자가 고친 기본 행은 D1 의 값으로, 새 항목은 추가, 나머지 기본 행은 그대로
    const jo = r1.tables.find((t) => t.table === 'job_options')!;
    expect([jo.replaced, jo.inserted]).toEqual([1, 1]);
    expect((await db.query("SELECT label_ko, sort, active, updated_by FROM job_options WHERE kind = 'industry' AND code = 'trade'")).rows[0])
      .toEqual({ label_ko: '무역·수출입', sort: 5, active: 0, updated_by: 'adm' });
    expect(await n('SELECT COUNT(*) AS n FROM job_options')).toBe(50);
    // 숫자 형·NULL 그대로, 예전 엔진 id 도 그대로
    expect((await db.query("SELECT salary_min, rev, localize_engine, closes_at FROM jobs WHERE id = 'j1'")).rows[0]).toEqual({ salary_min: 4000, rev: 2, localize_engine: 'workers_ai', closes_at: null });
    const body = String(((await db.query("SELECT body FROM resumes WHERE id = 'r1'")).rows[0] as { body: string }).body);
    expect(await decryptText(await importEncKey(FAKE_KEY), body)).toContain('가짜 이름');
    // 다시 실행
    const r2 = await runImport({ client, sqlite, dryRun: false, log: quiet });
    expect(r2.ok).toBe(true);
    expect(r2.tables.every((t) => t.inserted === 0 && t.replaced === 0)).toBe(true);
    expect(r2.tables.find((t) => t.table === 'users')).toMatchObject({ source: 3, existing: 3 });
    expect(await n('SELECT COUNT(*) AS n FROM users')).toBe(3);
  });

  it('같은 기본 키가 이미 있으면 건너뛴다 (PostgreSQL 쪽 값 유지)', async () => {
    const { client, db } = await pgClient();
    await db.exec("INSERT INTO users (id, email, role, created_at, locale) VALUES ('s1','fake.seeker@example.test','seeker',2,'zh')");
    const r = await runImport({ client, sqlite: await loadExport(fx.sql), dryRun: false, log: quiet });
    expect(r.ok).toBe(true);
    expect(r.tables.find((t) => t.table === 'users')).toMatchObject({ inserted: 2, existing: 1 });
    expect((await db.query("SELECT locale FROM users WHERE id = 's1'")).rows[0]).toEqual({ locale: 'zh' });
  });

  it('다른 id 의 같은 이메일(유일 제약)은 추측하지 않고 충돌로 알리고, 모두 되돌린다 (id 만, 이메일은 보이지 않음)', async () => {
    const { client, db, n } = await pgClient();
    await db.exec("INSERT INTO users (id, email, role, created_at) VALUES ('other','fake.seeker@example.test','seeker',0)");
    const logs: string[] = [];
    const r = await runImport({ client, sqlite: await loadExport(fx.sql), dryRun: false, log: (l) => logs.push(l) });
    expect(r.ok).toBe(false);
    expect(r.committed).toBe(false);
    expect(r.conflicts).toContainEqual({ table: 'users', id: 's1', constraint: 'users_email_key' });
    // s1 을 가리키는 행은 외래키 오류로 같이 센다
    expect(r.conflicts.some((c) => c.table === 'resumes')).toBe(true);
    expect(await n('SELECT COUNT(*) AS n FROM users')).toBe(1); // 넣었던 것도 되돌림
    expect(JSON.stringify([r, logs])).not.toContain('@example.test');
  });

  it('내보내기에 모르는 표·컬럼이 있으면 멈춘다', async () => {
    const { client } = await pgClient();
    const sqlite = await loadExport(fx.sql);
    sqlite.exec('CREATE TABLE mystery (id TEXT); ALTER TABLE users ADD COLUMN nickname TEXT');
    const r = await runImport({ client, sqlite, dryRun: false, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('mystery');
    expect(r.problems.join('\n')).toContain('nickname');
  });
});

describe('가져오기: 파일', () => {
  it('DB 가 가리키는 키를 모두 모은다 (중복 없음)', async () => {
    expect(fileKeys(await loadExport(fx.sql))).toEqual({ keys: [IDS.rfile1, IDS.rfile2, IDS.missing, IDS.vdoc].sort(), bad: [] });
  });

  it('받기: 없는 것은 알리고, 이미 있는 것은 건너뛰고, rfiles/ 는 ENC_KEY 로 풀리는지 본다 (미리 보기는 받지 않는다)', async () => {
    const filesDir = join(tmp(), 'files');
    const keys = fileKeys(await loadExport(fx.sql)).keys;
    const fetchOne = async (k: string, dest: string) => {
      const b = fx.files[k];
      if (!b) return false;
      writeFileSync(dest, b);
      return true;
    };
    expect(await fetchFiles({ keys, filesDir, fetchOne, encKey: FAKE_KEY, dryRun: true })).toMatchObject({ total: 4, present: 0, fetched: 0, missing: [] });
    const r1 = await fetchFiles({ keys, filesDir, fetchOne, encKey: FAKE_KEY, dryRun: false });
    expect(r1).toMatchObject({ total: 4, present: 0, fetched: 3, missing: [IDS.missing], undecryptable: [] });
    expect(readFileSync(join(filesDir, ...IDS.vdoc.split('/')), 'utf8')).toBe('%PDF-1.4 biz cert');
    expect(await canDecryptFile(await importKey(FAKE_KEY), readFileSync(join(filesDir, ...IDS.rfile1.split('/'))), IDS.rfile1)).toBe(true);
    const r2 = await fetchFiles({ keys, filesDir, fetchOne, encKey: FAKE_KEY, dryRun: false });
    expect(r2).toMatchObject({ present: 3, fetched: 0, missing: [IDS.missing] });
    // 다른 키로는 풀리지 않는다고 알린다
    const other = await fetchFiles({ keys: [IDS.rfile1], filesDir: join(tmp(), 'f2'), fetchOne, encKey: OTHER_KEY, dryRun: false });
    expect(other.undecryptable).toEqual([IDS.rfile1]);
  });

  it('wrangler 명령·설정: 시험용 WRANGLER_CMD, 없으면 설치된 wrangler', () => {
    expect(wranglerCommand({ WRANGLER_CMD: '/x/fake.mjs' })).toEqual([process.execPath, ['/x/fake.mjs']]);
    expect(wranglerCommand({})[1][0]).toContain(join('node_modules', 'wrangler'));
    const d = tmp();
    const cfg = JSON.parse(readFileSync(writeWranglerConfig(d, { d1Name: 'recruit-test', d1Id: 'id1', bucket: 'b1' }), 'utf8'));
    expect(cfg.d1_databases[0]).toEqual({ binding: 'DB', database_name: 'recruit-test', database_id: 'id1' });
    expect(cfg.r2_buckets[0].bucket_name).toBe('b1');
  });
});

// ── 명령 전체: 가짜 wrangler + 실제 PostgreSQL (PG_TEST_URL 이 있을 때만). 새 DB 를 만들고 npm run db:migrate 와 같은 실행기로 스키마를 넣는다.
const PG_URL = process.env.PG_TEST_URL ?? '';
describe.skipIf(!PG_URL)('가져오기 명령 (가짜 wrangler · 실제 PostgreSQL)', () => {
  it('미리 보기 → 가져오기 → 다시 실행, 다른 ENC_KEY 는 멈춤, 출력에 이메일·암호문 없음, 임시 파일 없음', async () => {
    const dbName = `imp_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE template0 ENCODING 'UTF8'`);
    const u = new URL(PG_URL);
    u.pathname = `/${dbName}`;
    const work = tmp();
    const r2 = join(work, 'r2');
    for (const [k, b] of Object.entries(fx.files)) {
      mkdirSync(dirname(join(r2, ...k.split('/'))), { recursive: true });
      writeFileSync(join(r2, ...k.split('/')), b);
    }
    writeFileSync(join(work, 'export.sql'), fx.sql);
    const log = join(work, 'wrangler.log');
    const env = {
      ...process.env, DATABASE_URL: u.toString(), ENC_KEY: FAKE_KEY, SESSION_PEPPER: 'fake-pepper-0123456789', DATA_DIR: join(work, 'data'),
      WRANGLER_CMD: resolve('test/fixtures/fake-wrangler.mjs'), FAKE_D1_SQL: join(work, 'export.sql'), FAKE_R2_DIR: r2, FAKE_WRANGLER_LOG: log, TMPDIR: work,
    };
    const run = (script: string, args: string[] = [], e: Record<string, string | undefined> = env) =>
      spawnSync(process.execPath, [script, ...args], { env: e, encoding: 'utf8', input: '' });
    try {
      const m = run('scripts/db-migrate.mjs');
      expect(m.status, m.stderr).toBe(0);
      expect(run('scripts/db-migrate.mjs').stdout).toContain('새로 적용할 것이 없습니다');
      const dry = run('scripts/import-from-cloudflare.mjs', ['--dry-run']);
      expect(dry.status, dry.stdout + dry.stderr).toBe(0);
      expect(dry.stdout).toContain('[미리 보기]');
      const c = new pg.Client({ connectionString: u.toString() });
      await c.connect();
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM users')).rows[0].n)).toBe(0);
      const real = run('scripts/import-from-cloudflare.mjs');
      expect(real.status, real.stdout + real.stderr).toBe(0);
      expect(real.stdout).toContain('받음 3');
      expect(real.stdout).toContain(`R2 에 없음: ${IDS.missing}`);
      expect(real.stdout).toContain('R2 목록 명령이 없어');
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM users')).rows[0].n)).toBe(3);
      expect(existsSync(join(work, 'data', 'files', ...IDS.rfile1.split('/')))).toBe(true);
      const again = run('scripts/import-from-cloudflare.mjs');
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('이미 있음 3');
      expect(Number((await c.query('SELECT COUNT(*) AS n FROM applications')).rows[0].n)).toBe(2);
      const wrong = run('scripts/import-from-cloudflare.mjs', [], { ...env, ENC_KEY: OTHER_KEY });
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain('ENC_KEY 가 예전 테스트 서버의 키와 다릅니다');
      await c.end();
      for (const out of [dry, real, again, wrong]) {
        const all = out.stdout + out.stderr;
        expect(all).not.toContain('@example.test');
        expect(all).not.toContain('v1.');
        expect(all).not.toContain('fake-pepper');
      }
      // wrangler 에 넘긴 인자 (4.166 에서 확인한 모양)
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      expect(calls[0]!.slice(0, 4)).toEqual(['d1', 'export', 'recruit-test', '--remote']);
      expect(calls.some((a) => a[0] === 'r2' && a[2] === 'get' && a[3] === `recruit-test-files/${IDS.rfile1}` && a.includes('--file'))).toBe(true);
      // 임시 폴더(내보낸 .sql)를 남기지 않는다
      expect(spawnSync('sh', ['-c', `ls -d ${work}/recruit-import-* 2>/dev/null | wc -l`], { encoding: 'utf8' }).stdout.trim()).toBe('0');
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
