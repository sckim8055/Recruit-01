// 배포 (T-13).  npm run deploy:test  /  npm run deploy:prod   (Windows: deploy-test.bat 더블클릭)
// 1) 배포 전 점검 (npm 이 predeploy:* 를 먼저 실행했으면 그 결과를 쓰고, 아니면 여기서 실행)
// 2) 운영이면 사이트 도메인을 직접 입력해 확인 (다른 서버에 잘못 올리지 않게)
// 3) npx wrangler deploy [--env production]
import { pathToFileURL } from 'node:url';
import { ask, fail, readConfig, wrangler } from './lib/cli.mjs';
import { domainConfirmed, domainOf, envArg, envFlags, sectionOf } from './lib/deploy-checks.mjs';
import { runPredeploy, stampIsFresh } from './predeploy.mjs';

async function main() {
  const env = envArg(process.argv[2]);
  if (!env) fail('사용법: node scripts/deploy.mjs test | production');
  const label = env === 'production' ? '운영' : '테스트';

  if (!stampIsFresh(env)) {
    console.log('배포 전 점검을 실행합니다...');
    if (!runPredeploy(env).ok) process.exit(1);
  } else {
    console.log('배포 전 점검: 방금 통과했습니다.');
  }

  const domain = domainOf(sectionOf(readConfig(), env));
  if (env === 'production') {
    console.log(`\n지금 운영 서버(${domain})에 올리려고 합니다. 실제 회원이 쓰는 서버입니다.`);
    console.log('배포 전에 백업을 했는지 확인하세요 (npm run backup:prod 또는 backup-prod.bat).');
    const typed = await ask('계속하려면 운영 서버 도메인을 그대로 입력하세요 (취소: 그냥 Enter): ');
    if (!domainConfirmed(typed, domain)) fail('도메인이 맞지 않아 배포하지 않았습니다.');
  }

  console.log(`\n${label} 서버에 배포합니다: npx wrangler deploy ${envFlags(env).join(' ')}`);
  const code = wrangler(['deploy', ...envFlags(env)]);
  if (code !== 0) fail(`배포가 실패했습니다 (wrangler 종료 코드 ${code}). 위의 메시지를 확인하세요. docs/DEPLOY.md 6장.`);
  console.log(`\n[OK] 배포했습니다. https://${domain}/admin/system 에서 빨간 항목이 없는지 확인하세요.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
