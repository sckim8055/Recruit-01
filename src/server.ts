// Node 서버 진입점 (T-19). 실행: npm start (= node --env-file=.env dist/server.mjs, 빌드는 npm run build).
//
// - 127.0.0.1 에서만 연다 (PORT, 기본 8787). 바깥에서는 Cloudflare Tunnel 로만 들어온다 — 이 PC 의 방화벽에서 8787·5433 을 열지 않는다
//   (docs/DEPLOY.md 10장). 요청 IP 가 필요하면 터널이 붙이는 CF-Connecting-IP 만 믿는다 (X-Forwarded-For 는 브라우저가 꾸밀 수 있다).
//   지금 앱은 요청 IP 를 쓰지 않는다.
// - 앞단: 요청 본문 크기 제한(12MB — 사업자 서류 10MB·이력서 첨부 5MB + 폼) → public/ 정적 파일 → 앱(src/index.tsx).
// - DB: PostgreSQL (node-postgres Pool, src/db/pg.ts). 파일: DATA_DIR\files (src/lib/storage.ts). 공개 화면 캐시: 메모리 60초.
// - 예약 작업: 매시 정각 (src/lib/scheduler.ts, DB 권고 잠금으로 프로세스 하나만). SCHEDULER=off 면 끈다.
// - 끄기: Ctrl+C(SIGINT)·SIGTERM·SIGBREAK → 새 연결을 받지 않고, 돌고 있는 예약 작업을 기다리고, DB 연결을 닫는다.
// - 디버거(inspect) 포트를 연 채로는 dev 가 아니면 시작하지 않는다.
import inspector from 'node:inspector';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import app from './index';
import type { Env } from './env';
import { now } from './env';
import { MAINT_LOCK_KEY, withAdvisoryLock } from './db/locks';
import { putMaintSetting } from './db/maintenance';
import { runMaintenance } from './lib/maintenance';
import { LAST_RUN_KEY, lastRunOf, Scheduler } from './lib/scheduler';
import { PUBLIC_FILES } from './lib/static-files';
import { ConfigError, createRuntime, readServerConfig, startupLine } from './server-env';

/** 요청 본문 최대 크기: 사업자 서류 10MB(lib/files.MAX_UPLOAD_BYTES) + 폼 여유. 이력서 첨부는 5MB. */
export const BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** 자동 백업을 하는 정각 (UTC 18시 = 한국 시간 03시). */
export const AUTO_BACKUP_HOUR_UTC = 18;

/** 앞단(본문 제한·정적 파일) + 앱. env 는 요청마다 같은 것을 넘긴다. 테스트에서도 쓴다. */
export function buildRoot(env: Env, publicDir: string): Hono {
  const root = new Hono();
  root.use('*', bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.text('Payload Too Large', 413) }));
  const files = serveStatic({ root: publicDir });
  for (const p of PUBLIC_FILES) {
    root.get(p, async (c, next) => {
      await next();
      if (c.res.status === 200) {
        // 예전 Cloudflare 정적 파일과 같게: 브라우저가 매번 바뀌었는지 확인한다 (파일을 고치면 바로 반영).
        c.res.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        c.res.headers.set('X-Content-Type-Options', 'nosniff');
      }
    }, files);
  }
  root.all('*', (c) => app.fetch(c.req.raw, env));
  return root;
}

async function main(): Promise<void> {
  const codeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let cfg;
  try {
    cfg = readServerConfig(process.env, codeDir);
  } catch (e) {
    console.error(`[X] ${e instanceof ConfigError ? e.message : '설정을 읽지 못했습니다.'}`);
    process.exit(1);
  }
  if (inspector.url() && cfg.env.APP_ENV !== 'dev') {
    console.error('[X] 디버거(--inspect)가 켜진 채로는 서버를 시작하지 않습니다. 서비스 관리 프로그램의 디버거 설정을 끄세요.');
    process.exit(1);
  }
  mkdirSync(cfg.filesDir, { recursive: true });
  mkdirSync(cfg.backupDir, { recursive: true });

  const { pool, db, env } = await createRuntime(cfg, { pageCache: true });

  // 시작 전에 DB 에 붙는지 본다 (붙지 않아도 서버는 뜬다 — /admin/system 이 빨간색으로 보여 준다).
  try {
    await pool.query('SELECT 1', []);
  } catch {
    console.error('error: database not reachable at startup (check PostgreSQL service and DATABASE_URL)');
  }

  const root = buildRoot(env, join(codeDir, 'public'));
  const server = serve({ fetch: (req) => root.fetch(req), hostname: '127.0.0.1', port: cfg.port });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(`[X] 서버를 열 수 없습니다 (${e.code ?? 'error'}). 포트 ${cfg.port} 를 다른 프로그램이 쓰고 있는지 확인하세요.`);
    process.exit(1);
  });
  console.log(startupLine(cfg));

  let backupRunning = false;
  const runBackup = () => {
    if (backupRunning) return;
    backupRunning = true;
    const child = spawn(process.execPath, ['--env-file=.env', join(codeDir, 'scripts', 'backup.mjs'), '--auto'], { cwd: codeDir, stdio: 'inherit' });
    child.on('exit', (code) => { backupRunning = false; console.log(`backup: auto ${code === 0 ? 'ok' : 'failed'}`); });
    child.on('error', () => { backupRunning = false; console.log('backup: auto failed'); });
  };

  const scheduler = new Scheduler({
    run: (hourSec) => runMaintenance(env, hourSec),
    tryLock: (fn) => withAdvisoryLock(pool, MAINT_LOCK_KEY, fn),
    record: (hourSec, out) => putMaintSetting(db, LAST_RUN_KEY, JSON.stringify(lastRunOf(hourSec, now(), out)), now()),
    after: (hourSec) => { if (cfg.autoBackup && Math.floor(hourSec / 3600) % 24 === AUTO_BACKUP_HOUR_UTC) runBackup(); },
  });
  if (cfg.schedulerOn) scheduler.start();

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`server: stopping (${sig})`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    const closed = new Promise<void>((r) => server.close(() => r()));
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.(); // 쉬고 있는 keep-alive 연결은 바로 닫는다
    await closed;
    await scheduler.stop();
    await pool.end();
    console.log('server: stopped');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
  process.on('unhandledRejection', (e) => console.error('error:', e instanceof Error ? e.message : 'unhandled rejection'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
