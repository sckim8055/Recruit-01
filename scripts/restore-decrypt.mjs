// 백업 파일 풀기 (T-13).  node scripts/restore-decrypt.mjs backups/production-20261201-0930.sql.enc [풀어서 쓸 파일.sql]
// 암호화된 백업(.sql.enc)을 비밀문구로 풀어 .sql 파일로 쓴다. **DB 에 넣지는 않는다** — 넣는 것은 docs/DEPLOY.md 5-3 의 수동 단계.
// 풀린 .sql 에는 회원 이메일 등 개인정보가 평문으로 들어 있다 (이력서 내용은 ENC_KEY 로 암호화된 채). 쓰고 나면 바로 지운다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BackupDecryptError, decryptBackup } from './lib/backup-crypto.mjs';
import { askHidden, fail } from './lib/cli.mjs';

async function main() {
  const src = process.argv[2];
  if (!src || !src.endsWith('.sql.enc')) fail('사용법: node scripts/restore-decrypt.mjs <백업 파일.sql.enc> [풀어서 쓸 파일.sql]');
  if (!existsSync(src)) fail(`${src} 파일이 없습니다.`);
  const out = process.argv[3] ?? src.replace(/\.enc$/, '');
  if (existsSync(out)) fail(`${out} 가 이미 있습니다. 지우거나 다른 이름을 세 번째 인자로 주세요.`);
  const pass = await askHidden('백업 비밀문구: ');
  let plain;
  try {
    plain = decryptBackup(readFileSync(src), pass);
  } catch (e) {
    if (e instanceof BackupDecryptError && e.message === 'not_backup') fail('이 프로그램이 만든 백업 파일이 아닙니다.');
    if (e instanceof BackupDecryptError) fail('풀 수 없습니다: 비밀문구가 틀렸거나 파일이 손상(변경)되었습니다.');
    throw e;
  }
  writeFileSync(out, plain);
  console.log(`\n[OK] 풀었습니다: ${out}`);
  console.log('[!] 이 파일에는 개인정보가 평문으로 들어 있습니다. 대화창·메일·git 에 올리지 말고, 복구가 끝나면 바로 지우세요.');
  console.log('    DB 에 다시 넣는 방법과 주의(덮어쓰기)는 docs/DEPLOY.md 5-3 을 봅니다. 먼저 Time Travel(5-2)로 되돌릴 수 있는지 확인하세요.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
