// 서버 DB 에 마이그레이션 적용 (T-13).  npm run db:test:migrate  /  npm run db:prod:migrate
// = npx wrangler d1 migrations apply DB --remote [--env production]
// 운영은 먼저 백업했는지 묻고, 도메인을 입력해 확인한다. wrangler 도 적용할 목록을 보여 주고 한 번 더 묻는다.
import { pathToFileURL } from 'node:url';
import { ask, fail, readConfig, wrangler } from './lib/cli.mjs';
import { dbNameOf, domainConfirmed, domainOf, envArg, envFlags, PLACEHOLDER, sectionOf } from './lib/deploy-checks.mjs';

async function main() {
  const env = envArg(process.argv[2]);
  if (!env) fail('사용법: node scripts/db-migrate.mjs test | production');
  const sec = sectionOf(readConfig(), env);
  const db = (sec?.d1_databases ?? []).find((d) => d?.binding === 'DB');
  if (!db || String(db.database_id).includes(PLACEHOLDER)) {
    fail(`wrangler.jsonc 의 ${env === 'production' ? '운영' : '테스트'} 구역 database_id 가 아직 REPLACE_WITH_… 입니다. docs/DEPLOY.md 의 D1 만들기 단계를 먼저 하세요.`);
  }
  if (env === 'production') {
    const domain = domainOf(sec);
    console.log(`\n운영 DB(${dbNameOf(sec)})에 마이그레이션을 적용합니다. 되돌리기 어렵습니다.`);
    console.log('먼저 백업하세요: npm run backup:prod (또는 backup-prod.bat). D1 은 Time Travel 로도 되돌릴 수 있습니다 (docs/DEPLOY.md 5장).');
    const ok = await ask('백업을 마쳤으면 운영 서버 도메인을 입력하세요 (취소: 그냥 Enter): ');
    if (!domainConfirmed(ok, domain)) fail('취소했습니다. 아무것도 바뀌지 않았습니다.');
  }
  const code = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', ...envFlags(env)]);
  if (code !== 0) fail(`마이그레이션이 실패했습니다 (wrangler 종료 코드 ${code}). 실패한 파일은 되돌려지고 그 앞 파일까지는 적용된 상태입니다. 위 메시지를 개발자에게 보내세요.`);
  console.log('\n[OK] 마이그레이션을 적용했습니다.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
