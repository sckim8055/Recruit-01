// 예약 작업 단계 하나를 지금 실행한다 (T-19, 수동·시험용).  npm run maint -- <단계>   예: npm run maint -- closeJobs
// 예전에는 wrangler dev 에서 cron 문자열 "maint:<단계>" 로 했다 (APP_ENV=dev 에서만). 지금은 서버 PC 에서만 할 수 있는 명령이고 HTTP 경로는 없다.
// 서버의 실행기와 같은 DB 권고 잠금을 잡는다 — 정각 실행과 겹치면 기다리지 않고 "잠김" 으로 끝난다. 로그는 서버와 같은 `maint:` 한 줄.
// 운영(APP_ENV=production)에서는 단계 이름을 한 번 더 입력해야 한다 (데이터를 지우는 단계가 있다).
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from './env';
import { MAINT_LOCK_KEY, withAdvisoryLock } from './db/locks';
import { devForcedStep, runMaintenance, STEP_NAMES } from './lib/maintenance';
import { ConfigError, createRuntime, readServerConfig } from './server-env';

const ask = (q: string) => new Promise<string>((r) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); r(a); }); });

async function main(): Promise<void> {
  const step = devForcedStep(`maint:${process.argv[2] ?? ''}`);
  if (!step) {
    console.error(`사용법: npm run maint -- <단계>\n단계: ${STEP_NAMES.join(', ')}`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = readServerConfig(process.env, resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (e) {
    console.error(`[X] ${e instanceof ConfigError ? e.message : '설정을 읽지 못했습니다.'}`);
    process.exit(1);
  }
  if (cfg.env.APP_ENV === 'production' && (await ask(`운영 서버입니다. 실행하려면 단계 이름(${step})을 그대로 입력하세요: `)).trim() !== step) {
    console.error('취소했습니다.');
    process.exit(1);
  }
  const { pool, env } = await createRuntime(cfg, { pageCache: false, schedulerOn: false });
  try {
    const r = await withAdvisoryLock(pool, MAINT_LOCK_KEY, () => runMaintenance(env, now(), { force: step }));
    if (!r.acquired) {
      console.error('[!] 지금 다른 예약 작업이 돌고 있습니다 (서버의 정각 실행). 잠시 뒤 다시 실행하세요.');
      process.exitCode = 1;
    } else {
      process.exitCode = r.value.ok ? 0 : 1;
    }
  } finally {
    await pool.end();
  }
}

void main();
