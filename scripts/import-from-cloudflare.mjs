// 예전 Cloudflare 테스트 서버(D1 recruit-test + R2 recruit-test-files)의 데이터를 이 PC 의 PostgreSQL + 첨부파일 폴더로 가져온다 (T-19, 한 번만).
//
//   npm run import:cloudflare -- --dry-run     먼저 이것: 무엇이 들어갈지 개수·충돌만 보여 주고 아무것도 바꾸지 않는다 (파일도 받지 않는다)
//   npm run import:cloudflare                  실제로 가져온다. 여러 번 실행해도 된다 (이미 있는 행·파일은 건너뛴다)
//   추가 인자: --sql <내보낸 파일.sql> (이미 받아 둔 D1 내보내기를 쓴다) · --skip-files · --d1-name · --d1-id · --bucket
//
// 하는 일
//  1) wrangler d1 export <D1 이름> --remote --output <임시 폴더>\export.sql  (wrangler 4.166 에서 확인한 인자. 이 PC 에서 wrangler login 이 되어 있어야 한다)
//  2) 그 SQL 을 Node 내장 node:sqlite 의 메모리 DB 에 넣는다 (디스크에 SQLite 파일을 만들지 않는다). 임시 .sql 은 끝나면 지운다.
//  3) .env 의 ENC_KEY 로 암호문 하나 이상(이력서·지원서·2단계 비밀키)을 풀어 본다 → 안 풀리면 멈춘다 (키가 다르면 가져와도 이력서를 열 수 없다).
//     SESSION_PEPPER 는 해시라 확인할 방법이 없다 — 예전 서버와 같은 값인지 운영자가 확인한다 (복구 코드·해지 링크가 이 값에 묶여 있다).
//  4) 표마다 외래키 순서로 PostgreSQL 에 넣는다: 한 트랜잭션, 행마다 저장점(SAVEPOINT), INSERT … ON CONFLICT (기본 키) DO NOTHING.
//     - 같은 기본 키가 이미 있으면 건너뛴다 (= 중복 제거, 다시 실행해도 같은 결과).
//     - 다른 유일 제약(users.email 등)에 걸리면 추측하지 않고 "충돌" 로 세고, 충돌·오류가 하나라도 있으면 **모두 되돌린다** (id 만 보여 준다).
//     - job_options 는 PostgreSQL 이 처음 넣은 기본 행(updated_by 가 비어 있는 행)이면 D1 의 값으로 바꾼다 (관리자가 고친 이름·순서를 잃지 않게).
//     - 가져오지 않는 표: sessions · auth_codes · admin_totp_pending · totp_enrolments (모두 다시 로그인한다), d1_migrations, sqlite_* · _cf_*.
//  5) DB 행이 가리키는 파일(resumes.file_r2_key · applications.file_r2_key · verification_docs.r2_key)을
//     wrangler r2 object get <버킷>/<키> --remote --file … 로 받아 DATA_DIR\files\<키> 에 둔다 (이미 있으면 건너뛴다). 이력서·지원서 첨부는 ENC_KEY 로 풀리는지 확인만 한다.
//     wrangler 4.166 에는 R2 목록 명령이 없어 "DB 가 가리키지 않는 파일" 은 확인하지 못한다 (지원되면 개수만 알린다).
//  출력: 표별 개수와 id 만. 이메일·이름·내용은 출력하지 않는다.
//
// 이 스크립트는 실제 Cloudflare 계정으로 시험하지 못했다 (가짜 D1 내보내기·가짜 wrangler 로만 시험 — test/import.test.ts). docs/DEPLOY.md 6장.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';
import { ROOT, fail } from './lib/cli.mjs';
import { connect } from './lib/pg-cli.mjs';
import { dataPaths } from './lib/paths.mjs';

export const DEFAULTS = { d1Name: 'recruit-test', d1Id: 'b5478ded-7948-436a-8e2d-91507bd5ad30', bucket: 'recruit-test-files' };

/** 외래키 순서 (참조되는 표 먼저). test/import.test.ts 가 PostgreSQL 스키마의 모든 표가 여기나 SKIP 에 있는지 본다. */
export const TABLE_ORDER = [
  'users', 'agencies', 'companies', 'company_members', 'agency_members', 'company_invites', 'verification_docs', 'jobs', 'seeker_profiles',
  'resumes', 'applications', 'application_events', 'consents', 'alerts', 'alert_unsub_tokens', 'translations', 'email_log', 'access_log',
  'reports', 'site_settings', 'job_options', 'usage_counters', 'totp_recovery_codes', 'admin_actions',
];
/** 가져오지 않는 표 (이유는 머리말 4). */
export const SKIP_TABLES = ['sessions', 'auth_codes', 'admin_totp_pending', 'totp_enrolments', 'd1_migrations', 'schema_migrations'];
const isInternal = (t) => t.startsWith('sqlite_') || t.startsWith('_cf_');

/** 파일 키 (src/lib/storage.ts isSafeKey 와 같은 규칙 — test/import.test.ts 가 비교). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
export const isSafeKey = (key) => typeof key === 'string' && !!key && key.length <= 200
  && key.split('/').every((p) => SEGMENT.test(p) && !p.includes('..') && !p.endsWith('.') && !RESERVED.test(p));

// ───────── 1·2. D1 내보내기 → 메모리 SQLite

export async function loadExport(sqlText) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(sqlText);
  return db;
}

export const sqliteTables = (sqlite) =>
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)).filter((t) => !isInternal(t));

// ───────── 3. ENC_KEY 확인

const fromB64 = (s) => Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

export async function importKey(b64) {
  const raw = fromB64(String(b64 ?? '').trim());
  if (raw.length !== 32) throw new Error('bad_key_length');
  return webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

/** "v1.<iv>.<ct>" (src/lib/crypto.encryptText) 를 풀 수 있는가. 푼 글은 버린다. */
export async function canDecryptText(key, stored) {
  const [ver, iv, ct] = String(stored).split('.');
  if (ver !== 'v1' || !iv || !ct) return false;
  try {
    await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct));
    return true;
  } catch {
    return false;
  }
}

/** 첨부파일 바이트 "RF1"+iv+암호문 (src/lib/resume-files.encryptFile, 키 문자열이 AAD) 을 풀 수 있는가. */
export async function canDecryptFile(key, bytes, fileKey) {
  const b = Uint8Array.from(bytes);
  if (b.length < 31 || b[0] !== 0x52 || b[1] !== 0x46 || b[2] !== 0x31) return false;
  try {
    await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(3, 15), additionalData: new TextEncoder().encode(fileKey) }, key, b.subarray(15));
    return true;
  } catch {
    return false;
  }
}

/** 암호문 컬럼 (CLAUDE.md 규칙 5 의 🔒). */
export const ENCRYPTED_COLUMNS = [
  ['resumes', 'body'], ['applications', 'resume_snapshot'], ['applications', 'summary_zh'], ['users', 'totp_secret'],
  ['seeker_profiles', 'name'], ['seeker_profiles', 'phone'],
];

/** 내보낸 DB 의 암호문을 최대 limit 개 풀어 본다. { checked, failed } */
export async function checkEncKey(sqlite, keyB64, limit = 5) {
  const key = await importKey(keyB64);
  const tables = new Set(sqliteTables(sqlite));
  let checked = 0, failed = 0;
  for (const [t, c] of ENCRYPTED_COLUMNS) {
    if (!tables.has(t) || checked >= limit) continue;
    const cols = sqlite.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name);
    if (!cols.includes(c)) continue;
    for (const r of sqlite.prepare(`SELECT "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL AND "${c}" != '' LIMIT ?`).all(limit - checked)) {
      checked++;
      if (!(await canDecryptText(key, r.v))) failed++;
    }
  }
  return { checked, failed };
}

// ───────── 4. PostgreSQL 에 넣기

async function pgColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return r.rows;
}

async function pgPrimaryKey(client, table) {
  const r = await client.query(
    `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [table]);
  return r.rows.map((x) => x.col);
}

export async function pgTables(client) {
  const r = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name", []);
  return r.rows.map((x) => x.table_name);
}

/** SQLite 값 → PostgreSQL 값. 맞지 않으면 예외 (내용은 넣지 않는다). */
export function convertValue(v, dataType) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) throw new Error('blob_value');
  if (dataType === 'bigint' || dataType === 'integer' || dataType === 'smallint') {
    const n = typeof v === 'bigint' ? Number(v) : Number(v);
    if (!Number.isSafeInteger(n)) throw new Error('not_integer');
    return n;
  }
  if (dataType === 'text') return typeof v === 'string' ? v : String(v);
  if (dataType === 'double precision' || dataType === 'numeric') return Number(v);
  return v;
}

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * 가져오기. client = { query(text, params) → { rows, rowCount } } (node-postgres Client 또는 테스트의 PGlite).
 * 돌려주는 값: { ok, committed, tables: [{ table, source, inserted, existing, replaced, conflicts, errors }], problems: [문장], conflicts: [{table, id, constraint}] }
 */
export async function runImport({ client, sqlite, dryRun, log = () => {} }) {
  const report = { ok: true, committed: false, tables: [], problems: [], conflicts: [], skipped: [], unknown: [] };
  const inExport = sqliteTables(sqlite);
  const pg = new Set(await pgTables(client));
  for (const t of inExport) {
    if (SKIP_TABLES.includes(t)) report.skipped.push(t);
    else if (!TABLE_ORDER.includes(t) || !pg.has(t)) report.unknown.push(t);
  }
  if (report.unknown.length) report.problems.push(`이 프로그램이 모르는 표가 내보내기에 있습니다: ${report.unknown.join(', ')}`);

  await client.query('BEGIN', []);
  try {
    for (const table of TABLE_ORDER) {
      if (!inExport.includes(table)) continue;
      const cols = await pgColumns(client, table);
      const pk = await pgPrimaryKey(client, table);
      const srcCols = sqlite.prepare(`PRAGMA table_info(${qi(table)})`).all().map((r) => String(r.name));
      const pgNames = cols.map((c) => c.column_name);
      const extra = srcCols.filter((c) => !pgNames.includes(c));
      if (extra.length) report.problems.push(`${table}: PostgreSQL 에 없는 컬럼 ${extra.join(', ')}`);
      const missingRequired = cols.filter((c) => !srcCols.includes(c.column_name) && c.is_nullable === 'NO' && c.column_default === null);
      if (missingRequired.length) report.problems.push(`${table}: 내보내기에 없는 필수 컬럼 ${missingRequired.map((c) => c.column_name).join(', ')}`);
      const use = cols.filter((c) => srcCols.includes(c.column_name));
      const names = use.map((c) => qi(c.column_name)).join(', ');
      const ph = use.map((_, i) => `$${i + 1}`).join(', ');
      let conflict = `ON CONFLICT (${pk.map(qi).join(', ')}) DO NOTHING`;
      if (table === 'job_options') {
        const set = use.filter((c) => !pk.includes(c.column_name)).map((c) => `${qi(c.column_name)} = excluded.${qi(c.column_name)}`).join(', ');
        conflict = `ON CONFLICT (kind, code) DO UPDATE SET ${set} WHERE job_options.updated_by IS NULL
          AND (job_options.label_ko, job_options.label_zh, job_options.sort, job_options.active) IS DISTINCT FROM (excluded.label_ko, excluded.label_zh, excluded.sort, excluded.active)`;
      }
      const sql = `INSERT INTO ${qi(table)} (${names}) VALUES (${ph}) ${conflict}`;
      const t = { table, source: 0, inserted: 0, existing: 0, replaced: 0, conflicts: 0, errors: 0 };
      const rows = sqlite.prepare(`SELECT ${use.map((c) => qi(c.column_name)).join(', ')} FROM ${qi(table)}`).all();
      for (const row of rows) {
        t.source++;
        const idOf = () => pk.map((k) => String(row[k])).join('|');
        let values;
        try {
          values = use.map((c) => convertValue(row[c.column_name], c.data_type));
        } catch (e) {
          t.errors++;
          report.conflicts.push({ table, id: idOf(), constraint: `type:${e.message}` });
          continue;
        }
        await client.query('SAVEPOINT imp', []);
        try {
          let exists = false;
          if (table === 'job_options') {
            exists = (await client.query('SELECT 1 FROM job_options WHERE kind = $1 AND code = $2', [row.kind, row.code])).rows.length > 0;
          }
          const r = await client.query(sql, values);
          if (table === 'job_options' && exists) {
            if (r.rowCount === 1) t.replaced++;
            else t.existing++;
          } else if (r.rowCount === 1) t.inserted++;
          else t.existing++;
          await client.query('RELEASE SAVEPOINT imp', []);
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT imp', []);
          await client.query('RELEASE SAVEPOINT imp', []);
          if (e?.code === '23505') t.conflicts++;
          else t.errors++;
          report.conflicts.push({ table, id: idOf(), constraint: e?.constraint ?? e?.code ?? 'error' });
        }
      }
      report.tables.push(t);
      log(`  ${table}: 내보내기 ${t.source} · 새로 ${t.inserted} · 이미 있음 ${t.existing}${t.replaced ? ` · 기본 행 바꿈 ${t.replaced}` : ''}${t.conflicts ? ` · 충돌 ${t.conflicts}` : ''}${t.errors ? ` · 오류 ${t.errors}` : ''}`);
    }
    // 시퀀스(자동 번호)가 있으면 가장 큰 값으로 맞춘다. 지금 스키마에는 없다 (id 는 모두 글자).
    const seqCols = await client.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_default LIKE 'nextval(%'", []);
    for (const s of seqCols.rows) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${qi(s.column_name)}) FROM ${qi(s.table_name)}), 1))`, [s.table_name, s.column_name]);
    }
    report.sequences = seqCols.rows.length;
    const bad = report.conflicts.length > 0 || report.problems.length > 0;
    report.ok = !bad;
    if (dryRun || bad) {
      await client.query('ROLLBACK', []);
    } else {
      await client.query('COMMIT', []);
      report.committed = true;
    }
  } catch (e) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw e;
  }
  return report;
}

// ───────── 5. 파일

/** DB 행이 가리키는 파일 키 (중복 없음). 안전하지 않은 키는 bad 로. */
export function fileKeys(sqlite) {
  const tables = new Set(sqliteTables(sqlite));
  const keys = new Set();
  const bad = [];
  for (const [t, c] of [['resumes', 'file_r2_key'], ['applications', 'file_r2_key'], ['verification_docs', 'r2_key']]) {
    if (!tables.has(t)) continue;
    const cols = sqlite.prepare(`PRAGMA table_info(${qi(t)})`).all().map((r) => r.name);
    if (!cols.includes(c)) continue;
    for (const r of sqlite.prepare(`SELECT ${qi(c)} AS k FROM ${qi(t)} WHERE ${qi(c)} IS NOT NULL AND ${qi(c)} != ''`).all()) {
      if (isSafeKey(r.k)) keys.add(String(r.k));
      else bad.push(String(r.k).slice(0, 60));
    }
  }
  return { keys: [...keys].sort(), bad };
}

/**
 * 파일 받기. fetchOne(key, destPath) → true(받음) | false(없음). 이미 있는 파일은 건너뛴다.
 * 받은 rfiles/ 는 ENC_KEY 로 풀리는지 확인만 한다 (내용은 버린다).
 */
export async function fetchFiles({ keys, filesDir, fetchOne, encKey, dryRun, log = () => {} }) {
  const r = { total: keys.length, present: 0, fetched: 0, missing: [], undecryptable: [] };
  const key = encKey ? await importKey(encKey) : null;
  for (const k of keys) {
    const dest = join(filesDir, ...k.split('/'));
    if (existsSync(dest)) { r.present++; continue; }
    if (dryRun) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      if (!(await fetchOne(k, tmp)) || !existsSync(tmp)) { r.missing.push(k); continue; }
      if (key && k.startsWith('rfiles/') && !(await canDecryptFile(key, readFileSync(tmp), k))) r.undecryptable.push(k);
      renameSync(tmp, dest);
      r.fetched++;
      if (r.fetched % 20 === 0) log(`  파일 ${r.fetched}개 받음…`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return r;
}

// ───────── wrangler

/** wrangler 실행 명령: WRANGLER_CMD(시험용 가짜·다른 설치) → node_modules/wrangler → PATH 의 wrangler. */
export function wranglerCommand(pe = process.env) {
  const custom = (pe.WRANGLER_CMD ?? '').trim();
  if (custom) return /\.(c|m)?js$/.test(custom) ? [process.execPath, [custom]] : [custom, []];
  const local = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (existsSync(local)) return [process.execPath, [local]];
  return [process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler', []];
}

export function runWrangler(args, { capture = false, pe = process.env } = {}) {
  const [cmd, pre] = wranglerCommand(pe);
  const r = spawnSync(cmd, [...pre, ...args], { cwd: ROOT, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: cmd.endsWith('.cmd') });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 임시 wrangler 설정 (wrangler.jsonc 를 지웠으므로 D1 이름 → id 를 여기서 알려 준다). */
export function writeWranglerConfig(dir, o) {
  const p = join(dir, 'wrangler.import.json');
  writeFileSync(p, JSON.stringify({
    name: 'recruit-import', compatibility_date: '2026-11-01',
    d1_databases: [{ binding: 'DB', database_name: o.d1Name, database_id: o.d1Id }],
    r2_buckets: [{ binding: 'FILES', bucket_name: o.bucket }],
  }, null, 2));
  return p;
}

const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipFiles = process.argv.includes('--skip-files');
  const o = { d1Name: argOf('--d1-name') ?? DEFAULTS.d1Name, d1Id: argOf('--d1-id') ?? DEFAULTS.d1Id, bucket: argOf('--bucket') ?? DEFAULTS.bucket };
  const encKey = (process.env.ENC_KEY ?? '').trim();
  if (!encKey || !(process.env.SESSION_PEPPER ?? '').trim()) fail('.env 에 ENC_KEY 와 SESSION_PEPPER 가 없습니다. 예전 테스트 서버(Cloudflare)의 두 값을 그대로 넣어야 합니다 (docs/DEPLOY.md 3-1).');
  try { await importKey(encKey); } catch { fail('.env 의 ENC_KEY 가 32바이트 base64 값이 아닙니다.'); }
  let paths;
  try { paths = dataPaths(); } catch (e) { fail(e.message); }

  console.log(`\n${dryRun ? '[미리 보기 — 아무것도 바꾸지 않습니다]' : '[가져오기]'} D1 ${o.d1Name} · R2 ${o.bucket} → PostgreSQL · ${paths.filesDir}`);
  const tmp = mkdtempSync(join(tmpdir(), 'recruit-import-'));
  let client;
  let error = null;
  try {
    let sqlText;
    const given = argOf('--sql');
    if (given) {
      sqlText = readFileSync(given, 'utf8');
      console.log('내보낸 파일을 씁니다 (--sql).');
    } else {
      const cfg = writeWranglerConfig(tmp, o);
      const out = join(tmp, 'export.sql');
      console.log('1) Cloudflare 에서 D1 을 내려받습니다 (wrangler d1 export)...');
      const r = runWrangler(['d1', 'export', o.d1Name, '--remote', '--output', out, '--skip-confirmation', '--config', cfg]);
      if (r.status !== 0 || !existsSync(out)) throw new Error(`D1 내려받기가 실패했습니다 (wrangler 종료 코드 ${r.status}). 이 PC 에서 npx wrangler login 을 했는지 확인하세요.`);
      sqlText = readFileSync(out, 'utf8');
    }
    const sqlite = await loadExport(sqlText);
    sqlText = '';
    rmSync(join(tmp, 'export.sql'), { force: true }); // 평문(개인정보)이 든 임시 파일은 바로 지운다

    console.log('2) .env 의 ENC_KEY 가 예전 서버의 키인지 확인합니다...');
    const kc = await checkEncKey(sqlite, encKey);
    if (kc.failed > 0) throw new Error(`ENC_KEY 가 예전 테스트 서버의 키와 다릅니다 (암호문 ${kc.checked}개 중 ${kc.failed}개를 풀지 못함). 가져오지 않았습니다.\n    .env 의 ENC_KEY 를 예전 서버(Cloudflare 에 넣었던 값)와 같게 고친 뒤 다시 실행하세요.`);
    const files = fileKeys(sqlite);
    if (kc.checked === 0) console.log('   DB 에 암호문이 없어 DB 로는 확인하지 못했습니다' + (files.keys.some((k) => k.startsWith('rfiles/')) ? ' — 첨부파일을 받을 때 확인합니다.' : '.'));
    else console.log(`   [OK] 암호문 ${kc.checked}개가 풀립니다.`);
    console.log('   SESSION_PEPPER 는 확인할 수 없습니다. 예전 서버와 같은 값이어야 복구 코드·알림 해지 링크가 그대로 동작합니다.');

    console.log('3) PostgreSQL 에 넣습니다 (한 트랜잭션)...');
    client = await connect();
    const mig = await client.query("SELECT to_regclass('schema_migrations') AS t", []);
    if (!mig.rows[0]?.t) throw new Error('PostgreSQL 에 스키마가 없습니다. 먼저 npm run db:migrate 를 실행하세요.');
    const rep = await runImport({ client, sqlite, dryRun, log: console.log });
    if (rep.skipped.length) console.log(`   가져오지 않은 표: ${rep.skipped.join(', ')} (세션·로그인 대기 — 모두 다시 로그인합니다)`);
    for (const p of rep.problems) console.log(`   [X] ${p}`);
    for (const c of rep.conflicts.slice(0, 50)) console.log(`   [X] 충돌: ${c.table} id=${c.id} (${c.constraint})`);
    if (rep.conflicts.length > 50) console.log(`   … 충돌 ${rep.conflicts.length - 50}개 더`);
    if (!rep.ok) throw new Error('충돌·문제가 있어 DB 에 아무것도 넣지 않았습니다 (되돌림). 위 id 를 확인하고(예: PostgreSQL 에 같은 이메일로 먼저 만든 계정) 정리한 뒤 다시 실행하세요.');
    console.log(rep.committed ? '   [OK] DB 에 넣었습니다.' : '   [미리 보기] 되돌렸습니다 (실제로 넣으려면 --dry-run 없이).');

    if (skipFiles) {
      console.log('4) 파일은 건너뜁니다 (--skip-files).');
    } else {
      console.log(`4) 첨부파일 ${files.keys.length}개 (DB 가 가리키는 것)${dryRun ? ' — 미리 보기에서는 받지 않습니다' : ''}...`);
      if (files.bad.length) console.log(`   [!] 모양이 맞지 않아 건너뛴 키 ${files.bad.length}개`);
      const cfg = writeWranglerConfig(tmp, o);
      const fr = await fetchFiles({
        keys: files.keys, filesDir: paths.filesDir, encKey, dryRun, log: console.log,
        fetchOne: async (k, dest) => runWrangler(['r2', 'object', 'get', `${o.bucket}/${k}`, '--remote', '--file', dest, '--config', cfg], { capture: true }).status === 0,
      });
      console.log(`   이미 있음 ${fr.present} · 받음 ${fr.fetched} · 없음 ${fr.missing.length}${dryRun ? ` · 받을 것 ${fr.total - fr.present}` : ''}`);
      for (const k of fr.missing.slice(0, 50)) console.log(`   [!] R2 에 없음: ${k}`);
      if (fr.undecryptable.length) {
        for (const k of fr.undecryptable.slice(0, 20)) console.log(`   [X] ENC_KEY 로 풀리지 않는 파일: ${k}`);
        if (kc.checked === 0) throw new Error('첨부파일이 ENC_KEY 로 풀리지 않습니다 — .env 의 ENC_KEY 가 예전 서버와 다를 수 있습니다. 확인한 뒤 다시 실행하세요.');
      }
      const help = runWrangler(['r2', 'object', '--help'], { capture: true });
      if (/object list/.test(help.stdout + help.stderr)) {
        const ls = runWrangler(['r2', 'object', 'list', o.bucket, '--remote', '--config', cfg], { capture: true });
        const listed = new Set((ls.stdout.match(/(?:rfiles|vdocs)\/[A-Za-z0-9._/-]+/g) ?? []).filter(isSafeKey));
        const orphans = [...listed].filter((k) => !files.keys.includes(k));
        console.log(`   R2 목록: ${listed.size}개, DB 가 가리키지 않는 것 ${orphans.length}개 (가져오지 않음)`);
      } else {
        console.log('   이 wrangler 에는 R2 목록 명령이 없어 DB 가 가리키지 않는 파일은 확인하지 못했습니다 (가져올 필요는 없다).');
      }
    }
    console.log(dryRun ? '\n[미리 보기 끝] 문제가 없으면 --dry-run 없이 다시 실행하세요.' : '\n[끝] /admin/system 과 로그인·이력서 첨부 내려받기를 확인하세요. 다시 실행해도 같은 결과입니다.');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // 임시 폴더(내보낸 .sql·wrangler 설정)를 남기지 않는다
    await client?.end().catch(() => {});
  }
  if (error) fail(error);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
