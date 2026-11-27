// 백업 풀기 (T-19).  npm run restore -- <백업 파일.enc> [풀어서 쓸 폴더]
// 비밀문구로 풀어 폴더에 db.dump(pg_dump) · files\ (첨부파일) · RESTORE-STEPS.txt(손으로 하는 복구 순서)를 쓴다. **DB 에 넣지는 않는다.**
// 풀린 폴더에는 회원 이메일 등 개인정보가 평문으로 들어 있다 (이력서 내용·첨부는 ENC_KEY 로 암호화된 채). 복구가 끝나면 바로 지운다.
// 예전 Cloudflare D1 백업(.sql.enc, T-13)도 풀 수 있다 → .sql 파일 하나.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupDecryptError, decryptBackup } from './lib/backup-crypto.mjs';
import { isSafeEntryName, unpack } from './lib/backup-pack.mjs';
import { askHidden, fail } from './lib/cli.mjs';

export const RESTORE_STEPS = `복구 순서 (Windows PowerShell, 한 줄씩). docs/DEPLOY.md 7-3 과 같다.
이 폴더에는 개인정보가 평문으로 들어 있다. 대화창·메일·git 에 올리지 말고, 끝나면 폴더를 지운다.

1) 서비스 관리 프로그램에서 recruit 서버를 멈춘다.
2) 지금 DB 를 옆으로 옮겨 둔다 (되돌릴 수 있게):
   & "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe" -h localhost -p 5433 -U postgres -c "ALTER DATABASE recruit RENAME TO recruit_old"
3) 빈 DB 를 만든다:
   & "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe" -h localhost -p 5433 -U postgres -c "CREATE DATABASE recruit OWNER recruit ENCODING 'UTF8' TEMPLATE template0"
4) 이 폴더의 db.dump 를 넣는다 (이 폴더에서 실행):
   & "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_restore.exe" -h localhost -p 5433 -U recruit -d recruit --no-owner --exit-on-error db.dump
5) 첨부파일을 되돌린다 (지금 파일 폴더는 먼저 옆으로 옮겨 둔다):
   Rename-Item F:\\works\\Recruit-01-data\\files files_old
   Copy-Item -Recurse .\\files F:\\works\\Recruit-01-data\\files
6) .env 의 ENC_KEY·SESSION_PEPPER 가 백업을 만든 때와 같은지 확인한다 (다르면 이력서를 열 수 없다).
7) 서버를 켜고 https://recruit.kimbbob.xyz/admin/system 이 모두 정상인지 본다. 로그인·이력서 첨부 내려받기를 한 번 해 본다.
8) 문제가 없으면 recruit_old DB 와 files_old 폴더를 지운다:
   & "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe" -h localhost -p 5433 -U postgres -c "DROP DATABASE recruit_old"
9) 이 폴더(풀린 백업)를 지운다.
`;

/** 풀어서 outDir 에 쓴다. 돌려주는 값: { files, dbBytes }. outDir 은 없어야 한다. */
export function restoreTo(fileBytes, passphrase, outDir) {
  const entries = unpack(decryptBackup(fileBytes, passphrase));
  if (existsSync(outDir)) throw new Error(`${outDir} 가 이미 있습니다.`);
  mkdirSync(outDir, { recursive: true });
  let files = 0, dbBytes = 0;
  for (const e of entries) {
    if (!isSafeEntryName(e.name)) throw new Error('backup: bad entry name');
    const p = join(outDir, ...e.name.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, e.data, { flag: 'wx' });
    if (e.name.startsWith('files/')) files++;
    if (e.name === 'db.dump') dbBytes = e.data.length;
  }
  writeFileSync(join(outDir, 'RESTORE-STEPS.txt'), RESTORE_STEPS.replace(/\n/g, '\r\n'));
  return { files, dbBytes };
}

async function main() {
  const src = process.argv[2];
  if (!src || !src.endsWith('.enc')) fail('사용법: npm run restore -- <백업 파일.enc> [풀어서 쓸 폴더]');
  if (!existsSync(src)) fail(`${src} 파일이 없습니다.`);
  const legacy = src.endsWith('.sql.enc');
  const out = process.argv[3] ?? (legacy ? src.replace(/\.enc$/, '') : src.replace(/\.enc$/, '-restored'));
  if (existsSync(out)) fail(`${out} 가 이미 있습니다. 지우거나 다른 이름을 두 번째 인자로 주세요.`);
  const pass = await askHidden('백업 비밀문구: ');
  try {
    if (legacy) {
      writeFileSync(out, decryptBackup(readFileSync(src), pass), { flag: 'wx' });
      console.log(`\n[OK] 예전 Cloudflare D1 백업을 풀었습니다: ${out} (SQLite 문법의 .sql — PostgreSQL 에 그대로 넣을 수 없다. scripts/import-from-cloudflare.mjs --sql 로 가져온다)`);
    } else {
      const r = restoreTo(readFileSync(src), pass, out);
      console.log(`\n[OK] 풀었습니다: ${out}  (DB ${Math.round(r.dbBytes / 1024)} KB, 첨부파일 ${r.files}개)`);
      console.log('     복구 순서는 그 폴더의 RESTORE-STEPS.txt (docs/DEPLOY.md 7-3).');
    }
    console.log('[!] 풀린 파일에는 개인정보가 평문으로 들어 있습니다. 대화창·메일·git 에 올리지 말고, 복구가 끝나면 바로 지우세요.');
  } catch (e) {
    if (e instanceof BackupDecryptError && e.message === 'not_backup') fail('이 프로그램이 만든 백업 파일이 아닙니다.');
    if (e instanceof BackupDecryptError) fail('풀 수 없습니다: 비밀문구가 틀렸거나 파일이 손상(변경)되었습니다.');
    fail(e instanceof Error ? e.message : String(e));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
