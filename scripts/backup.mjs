// 암호화 백업 (T-19).  npm run backup          (비밀문구를 두 번 입력 — 화면에 보이지 않음)
//                       npm run backup -- --auto (서버의 자동 백업: .env 의 BACKUP_PASSPHRASE 로, 오래된 자동 백업은 BACKUP_KEEP 개만 남김)
//
// 1) pg_dump(PG_BIN 폴더, 기본 C:\Program Files\PostgreSQL\16\bin)로 recruit DB 를 내려받는다 — 메모리로만 받는다 (임시 파일 없음)
// 2) 첨부파일 폴더(DATA_DIR\files)의 파일을 모두 읽는다 (이력서·지원서 첨부는 이미 ENC_KEY 로 암호화된 바이트, 사업자 서류는 그대로)
// 3) 둘을 한 묶음으로 만들어 AES-256-GCM + scrypt(비밀문구) 로 암호화해 BACKUP_DIR\recruit-<yyyymmdd-hhmm>.enc 로 쓴다
//    (같은 폴더의 임시 이름에 쓴 뒤 이름 바꾸기 — 반쯤 쓴 백업 파일이 남지 않는다). 평문은 디스크에 쓰지 않는다.
// 이 백업에 **없는 것**: .env(ENC_KEY·SESSION_PEPPER 등 비밀값). ENC_KEY 없이는 백업을 풀어도 이력서를 읽을 수 없다 — 따로 보관한다.
// 풀기: npm run restore -- <백업 파일>  (docs/DEPLOY.md 7장)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encryptBackup, MIN_PASSPHRASE } from './lib/backup-crypto.mjs';
import { backupFileName, pack } from './lib/backup-pack.mjs';
import { askHidden, fail } from './lib/cli.mjs';
import { databaseUrl, pgEnvOf } from './lib/pg-cli.mjs';
import { dataPaths, pgTool } from './lib/paths.mjs';

/** 첨부파일 폴더의 파일 목록 (임시 파일·쓰기 시험 파일 제외). 키는 '/' 로 잇는다. */
export function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d, rel) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.tmp-') || ent.name.startsWith('.write-test-')) continue;
      const k = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(d, ent.name), k);
      else if (ent.isFile()) out.push(k);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** pg_dump -Fc 출력을 메모리로 받는다. 실패하면 예외 (비밀번호는 환경 변수로만 넘긴다 — 명령줄에 보이지 않게). */
export function pgDump(url, tool = pgTool('pg_dump')) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, ['--format=custom', '--no-owner', '--no-privileges'], { env: { ...process.env, ...pgEnvOf(url) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => reject(new Error(`pg_dump 를 실행할 수 없습니다 (${e.code ?? 'error'}). .env 의 PG_BIN 이 PostgreSQL 의 bin 폴더인지 확인하세요.`)));
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`pg_dump 가 실패했습니다 (종료 코드 ${code}): ${err.trim().split('\n')[0] ?? ''}`))));
  });
}

/**
 * 백업 파일을 만든다. dump = DB 덤프를 돌려주는 함수 (테스트에서 바꿔 넣는다). 돌려주는 값: { file, files, dbBytes }.
 * params 는 scrypt 강도 (테스트에서 낮춘다).
 */
export async function createBackup({ dump, filesDir, backupDir, passphrase, date = new Date(), params }) {
  if (String(passphrase ?? '').length < MIN_PASSPHRASE) throw new Error(`비밀문구가 너무 짧습니다 (${MIN_PASSPHRASE}자 이상).`);
  mkdirSync(backupDir, { recursive: true });
  const out = join(backupDir, backupFileName(date));
  if (existsSync(out)) throw new Error(`${backupFileName(date)} 가 이미 있습니다. 1분 뒤 다시 실행하세요.`);
  const db = await dump();
  if (!db.length) throw new Error('DB 덤프가 비어 있습니다. 백업하지 않았습니다.');
  const keys = listFiles(filesDir);
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ v: 1, created_at: Math.floor(date.getTime() / 1000), db_bytes: db.length, files: keys.length })) },
    { name: 'db.dump', data: db },
    ...keys.map((k) => ({ name: `files/${k}`, data: readFileSync(join(filesDir, ...k.split('/'))) })),
  ];
  const sealed = encryptBackup(pack(entries), passphrase, params);
  const tmp = join(backupDir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, sealed, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { file: out, files: keys.length, dbBytes: db.length };
}

/** 자동 백업: 가장 최근 keep 개만 남기고 오래된 recruit-*.enc 를 지운다 (지운 수). */
export function pruneBackups(backupDir, keep) {
  const files = readdirSync(backupDir).filter((f) => /^recruit-\d{8}-\d{4}\.enc$/.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) rmSync(join(backupDir, f), { force: true });
  return old.length;
}

async function main() {
  const auto = process.argv.includes('--auto');
  const url = databaseUrl();
  let paths;
  try {
    paths = dataPaths();
  } catch (e) {
    fail(e.message);
  }
  let pass = process.env.BACKUP_PASSPHRASE ?? '';
  if (auto) {
    if (pass.length < MIN_PASSPHRASE) fail(`자동 백업에는 .env 의 BACKUP_PASSPHRASE(${MIN_PASSPHRASE}자 이상)가 필요합니다.`);
  } else if (!pass) {
    console.log(`\n백업 비밀문구를 정해 입력하세요 (${MIN_PASSPHRASE}자 이상). 화면에 보이지 않습니다.`);
    console.log('이 비밀문구를 잃으면 백업을 풀 수 없습니다. ENC_KEY 와 함께 PC 밖(종이·비밀번호 관리 프로그램)에 따로 적어 두세요.');
    const p1 = await askHidden('비밀문구: ');
    if (p1.length < MIN_PASSPHRASE) fail(`비밀문구가 너무 짧습니다 (${MIN_PASSPHRASE}자 이상).`);
    const p2 = await askHidden('한 번 더: ');
    if (p1 !== p2) fail('두 번 입력한 비밀문구가 다릅니다. 처음부터 다시 실행하세요.');
    pass = p1;
  } else {
    console.log('.env 의 BACKUP_PASSPHRASE 로 암호화합니다.');
  }
  try {
    const r = await createBackup({ dump: () => pgDump(url), filesDir: paths.filesDir, backupDir: paths.backupDir, passphrase: pass });
    console.log(`[OK] 백업 파일: ${r.file} (DB ${Math.round(r.dbBytes / 1024)} KB, 첨부파일 ${r.files}개). 평문은 디스크에 쓰지 않았습니다.`);
    if (auto) {
      const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP ?? '14', 10) || 14);
      const n = pruneBackups(paths.backupDir, keep);
      if (n) console.log(`     오래된 백업 ${n}개를 지웠습니다 (최근 ${keep}개만 남김).`);
    } else {
      console.log('\n다음 할 일: 이 .enc 파일을 PC 밖(USB·클라우드 드라이브)에도 한 부 복사해 둡니다.');
      console.log(`풀기: npm run restore -- "${r.file}"`);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
