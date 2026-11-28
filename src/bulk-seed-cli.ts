// 대량 테스트 데이터 만들기·지우기 (T-21, 테스트 서버·개발 PC 전용).  npm run seed:bulk [-- --jobs 500 --companies 60 --seekers 300 --applications 1200 | --remove | --dry-run]
// 무엇을 어떻게 만드는지·안전장치는 lib/bulk-seed.ts 머리말. 운영(APP_ENV=production)에서는 DB 에 연결하기 전에 끝난다.
// 출력은 개수와 걸린 시간뿐이다 (이름·이메일·이력서 내용 없음).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from './env';
import { BULK_USAGE, parseBulkArgs, runBulkCommand } from './lib/bulk-seed';
import { ConfigError, createRuntime, readServerConfig } from './server-env';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(BULK_USAGE); return; }
  const args = parseBulkArgs(argv);
  if (!args.ok) {
    console.error(`[X] ${args.message}`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = readServerConfig(process.env, resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (e) {
    console.error(`[X] ${e instanceof ConfigError ? e.message : '설정을 읽지 못했습니다.'}`);
    process.exit(1);
  }
  if (cfg.env.APP_ENV === 'production') {
    console.error('[X] 운영 서버(APP_ENV=production)에서는 대량 테스트 데이터를 만들거나 지울 수 없습니다. 테스트 서버나 개발 PC 에서만 쓰세요.');
    process.exit(1);
  }
  const started = performance.now();
  const { pool, env } = await createRuntime(cfg, { pageCache: false, schedulerOn: false });
  try {
    process.exitCode = await runBulkCommand(env, args, now(), (line) => console.log(line));
    console.log(`  (걸린 시간 ${((performance.now() - started) / 1000).toFixed(1)}초)`);
  } catch {
    // 오류 내용(SQL·값)을 그대로 내보내지 않는다. 다시 실행하면 대량 데이터만 지우고 처음부터 다시 만든다.
    console.error('[X] 실패했습니다. DB 연결과 마이그레이션(npm run db:migrate)을 확인한 뒤 다시 실행하세요. 다시 실행하면 대량 데이터만 지우고 처음부터 만듭니다.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
