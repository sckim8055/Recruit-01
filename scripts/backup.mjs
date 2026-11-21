// 서버 DB 암호화 백업 (T-13).  npm run backup:test  /  npm run backup:prod   (Windows: backup-prod.bat 더블클릭)
//
// 1) 비밀문구를 두 번 입력받는다 (화면에 보이지 않음, 어디에도 저장하지 않음, 12자 이상)
// 2) npx wrangler d1 export <DB 이름> --remote --output <임시 .sql> [--env production]  → backups/ 안의 임시 파일
// 3) AES-256-GCM 으로 암호화해 backups/<환경>-<yyyymmdd-hhmm>.sql.enc 로 저장 (scripts/lib/backup-crypto.mjs)
// 4) 임시 평문 파일을 지운다 (실패·취소해도 지운다)
//
// 이 백업에 **없는 것**: R2 의 파일(이력서·지원서 첨부, 사업자 서류), 비밀값(ENC_KEY 등), 설정. docs/DEPLOY.md 5장.
// 이력서 내용·첨부는 DB 안에서도 ENC_KEY 로 암호화되어 있으므로, 이 백업을 풀어도 ENC_KEY 없이는 이력서를 읽을 수 없다.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encryptBackup, MIN_PASSPHRASE } from './lib/backup-crypto.mjs';
import { askHidden, fail, readConfig, ROOT, wrangler } from './lib/cli.mjs';
import { backupFileName, dbNameOf, envArg, envFlags, PLACEHOLDER, sectionOf } from './lib/deploy-checks.mjs';

async function main() {
  const env = envArg(process.argv[2]);
  if (!env) fail('사용법: node scripts/backup.mjs test | production');
  const sec = sectionOf(readConfig(), env);
  const dbName = dbNameOf(sec);
  const dbEntry = (sec?.d1_databases ?? []).find((d) => d?.binding === 'DB');
  if (!dbName || !dbEntry || String(dbEntry.database_id).includes(PLACEHOLDER)) fail('wrangler.jsonc 에 이 환경의 D1(database_id)이 아직 없습니다.');

  console.log(`\n${env === 'production' ? '운영' : '테스트'} DB(${dbName}) 를 백업합니다.`);
  console.log(`백업 비밀문구를 정해 입력하세요 (${MIN_PASSPHRASE}자 이상, 영문·숫자 권장). 화면에 보이지 않습니다.`);
  console.log('이 비밀문구를 잃으면 백업을 풀 수 없습니다. 비밀번호 관리 프로그램이나 종이에 따로 적어 두세요 (ENC_KEY 와 같은 곳).');
  const p1 = await askHidden('비밀문구: ');
  if (p1.length < MIN_PASSPHRASE) fail(`비밀문구가 너무 짧습니다 (${MIN_PASSPHRASE}자 이상).`);
  const p2 = await askHidden('한 번 더: ');
  if (p1 !== p2) fail('두 번 입력한 비밀문구가 다릅니다. 처음부터 다시 실행하세요.');

  const dir = join(ROOT, 'backups');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}.sql`);
  const out = join(dir, backupFileName(env));
  if (existsSync(out)) fail(`${relative(ROOT, out)} 가 이미 있습니다. 1분 뒤 다시 실행하세요.`);
  try {
    console.log('\nCloudflare 에서 DB 를 내려받습니다 (내려받는 동안 사이트의 DB 요청이 잠시 멈출 수 있습니다)...');
    const code = wrangler(['d1', 'export', dbName, '--remote', '--output', tmp, ...envFlags(env)]);
    // try 안에서는 fail()(바로 종료) 대신 throw — finally 가 임시 파일을 지우게.
    if (code !== 0 || !existsSync(tmp)) throw new Error(`내려받기가 실패했습니다 (wrangler 종료 코드 ${code}). npx wrangler login 을 했는지 확인하세요.`);
    const plain = readFileSync(tmp);
    if (!plain.length) throw new Error('내려받은 파일이 비어 있습니다. 백업하지 않았습니다.');
    console.log('암호화합니다...');
    writeFileSync(out, encryptBackup(plain, p1));
    console.log(`\n[OK] 백업 파일: ${relative(ROOT, out)} (${Math.round(plain.length / 1024)} KB 평문 → 암호화)`);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log('     임시 평문 파일은 지웠습니다.');
  console.log('\n다음 할 일:');
  console.log('  1) 이 .sql.enc 파일을 PC 밖(USB·클라우드 드라이브)에도 한 부 복사해 둡니다. backups 폴더는 git 에 올라가지 않습니다.');
  console.log('  2) 복구가 필요하면: node scripts/restore-decrypt.mjs ' + relative(ROOT, out).replaceAll('\\', '/') + '  → 풀린 .sql 로 docs/DEPLOY.md 5-3 의 순서를 따릅니다.');
  console.log('  3) R2 파일(이력서·지원서 첨부, 사업자 서류)은 이 백업에 들어 있지 않습니다 (docs/DEPLOY.md 5-4).');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
