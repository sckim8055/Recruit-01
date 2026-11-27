// .env(process.env) → Env 의 문자열 부분 (T-19). 순수 함수 — test/server.test.ts.
// 알려진 이름만 옮긴다 (process.env 전체를 앱에 넘기지 않는다). 비밀값은 여기서 출력하지 않는다.
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { now, type Env } from './env';
import { createDb, createPool, poolBackend } from './db/pg';
import type { Db } from './db/types';
import { fsFileStore } from './lib/storage';
import { MemoryPageCache } from './lib/page-cache';

/** Env 의 문자열 이름들 (DB·FILES·RUNTIME·PAGE_CACHE 는 서버가 만든다). */
export const ENV_STRING_KEYS = [
  'APP_ENV', 'APP_ORIGIN', 'MAIL_FROM', 'OPERATOR_DOMAINS', 'REGISTRATION_NO',
  'FLAG_PRODUCTION_JOBS', 'FLAG_HEADHUNTER_POSTING', 'FLAG_RESUME_ZH_SUMMARY', 'FLAG_PAID_LABEL',
  'MAINTENANCE', 'DEMO_LOGIN', 'LOCALIZE_ENGINE', 'LOCALIZE_GEMINI_MODEL', 'LOCALIZE_CLAUDE_MODEL', 'OPS_EMAIL',
  'LOCALIZE_PER_COMPANY_DAY', 'LOCALIZE_SITE_DAY', 'ADMIN_LOCALIZE_TEST_DAY', 'MAIL_PER_COMPANY_DAY', 'MAIL_SITE_DAY',
  'DRAFT_JOBS_PER_COMPANY', 'ALERT_MAIL_SITE_DAY', 'ALERT_SEND_PER_RUN', 'DATA_DIR', 'BACKUP_DIR',
  'ENC_KEY', 'SESSION_PEPPER', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DATABASE_URL', 'BACKUP_PASSPHRASE',
] as const;

/** 기본 데이터 폴더 (운영자 PC). 코드 폴더 밖이어야 한다. */
export const DEFAULT_DATA_DIR = 'F:\\works\\Recruit-01-data';

export type EnvStrings = Omit<Env, 'DB' | 'FILES' | 'RUNTIME' | 'PAGE_CACHE'>;

export interface ServerConfig {
  env: EnvStrings;
  port: number;
  databaseUrl: string;
  filesDir: string;
  backupDir: string;
  schedulerOn: boolean;
  /** 자동 백업 (BACKUP_AUTO=on 이고 BACKUP_PASSPHRASE 가 있을 때만). */
  autoBackup: boolean;
}

export class ConfigError extends Error {}

const FLAG_DEFAULT_OFF = ['FLAG_PRODUCTION_JOBS', 'FLAG_HEADHUNTER_POSTING', 'FLAG_RESUME_ZH_SUMMARY', 'FLAG_PAID_LABEL'] as const;

/** 경로가 base 폴더 안(같은 폴더 포함)인가. */
export const isInside = (path: string, base: string): boolean => {
  const r = relative(resolve(base), resolve(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * process.env → 서버 설정. 꼭 필요한 값이 없으면 ConfigError (한국어 안내).
 * codeDir = 코드 폴더 (데이터 폴더가 그 안이면 거절 — 첨부파일이 git·빌드에 섞이지 않게).
 */
export function readServerConfig(pe: Record<string, string | undefined>, codeDir: string, platform: string = process.platform): ServerConfig {
  const get = (k: string) => (pe[k] ?? '').trim();
  const env = Object.fromEntries(ENV_STRING_KEYS.map((k) => [k, pe[k] ?? ''])) as Record<string, string>;
  for (const f of FLAG_DEFAULT_OFF) if (!env[f]) env[f] = 'off'; // 기능 플래그는 없으면 꺼짐 (CLAUDE.md 규칙 9)
  if (!['dev', 'test', 'production'].includes(get('APP_ENV'))) throw new ConfigError('.env 의 APP_ENV 가 dev · test · production 중 하나가 아닙니다.');
  env.APP_ENV = get('APP_ENV');
  const databaseUrl = get('DATABASE_URL');
  if (!databaseUrl) throw new ConfigError('.env 에 DATABASE_URL(PostgreSQL 접속 문자열)이 없습니다. docs/DEPLOY.md 3장.');
  if (!get('ENC_KEY') || !get('SESSION_PEPPER')) throw new ConfigError('.env 에 ENC_KEY 와 SESSION_PEPPER 가 모두 있어야 합니다. docs/DEPLOY.md 3-1.');
  if (!get('APP_ORIGIN')) throw new ConfigError('.env 에 APP_ORIGIN(예: https://recruit.kimbbob.xyz)이 없습니다.');

  const portRaw = get('PORT') || '8787';
  if (!/^\d{2,5}$/.test(portRaw) || Number(portRaw) < 1024 || Number(portRaw) > 65535) throw new ConfigError('.env 의 PORT 는 1024~65535 의 숫자여야 합니다.');

  const winPath = platform === 'win32';
  const dataDir = get('DATA_DIR') || (winPath ? DEFAULT_DATA_DIR : '');
  if (!dataDir) throw new ConfigError('.env 에 DATA_DIR(첨부파일·백업 폴더의 상위 폴더)이 없습니다.');
  const abs = (p: string) => (winPath ? win32.resolve(p) : resolve(p));
  const filesDir = abs(join(dataDir, 'files'));
  const backupDir = abs(get('BACKUP_DIR') || join(dataDir, 'backups'));
  for (const [name, p] of [['DATA_DIR', filesDir], ['BACKUP_DIR', backupDir]] as const) {
    if (isInside(p, codeDir)) throw new ConfigError(`${name} 가 코드 폴더 안에 있습니다. 코드 폴더 밖의 폴더(예: ${DEFAULT_DATA_DIR})를 쓰세요.`);
  }
  env.DATA_DIR = dataDir;
  env.BACKUP_DIR = backupDir;

  return {
    env: env as unknown as EnvStrings,
    port: Number(portRaw),
    databaseUrl,
    filesDir,
    backupDir,
    schedulerOn: get('SCHEDULER').toLowerCase() !== 'off',
    autoBackup: get('BACKUP_AUTO').toLowerCase() === 'on' && get('BACKUP_PASSPHRASE').length >= 12,
  };
}

/** 시작 로그 한 줄 (비밀값·접속 문자열 없음). */
export const startupLine = (c: ServerConfig): string =>
  `server: env=${c.env.APP_ENV} listen=127.0.0.1:${c.port} origin=${c.env.APP_ORIGIN} scheduler=${c.schedulerOn ? 'on' : 'off'} auto_backup=${c.autoBackup ? 'on' : 'off'}`;

/** DB 연결·파일 저장소·(선택) 공개 화면 캐시를 만들어 Env 를 완성한다. 서버(src/server.ts)와 수동 예약 작업(src/maint-cli.ts)이 같이 쓴다. */
export async function createRuntime(cfg: ServerConfig, o: { pageCache: boolean; schedulerOn?: boolean } = { pageCache: false }) {
  const pool = await createPool({ connectionString: cfg.databaseUrl });
  pool.on('error', () => console.error('error: db pool connection error')); // 쉬는 연결이 끊겨도 계속 (메시지에 주소를 넣지 않는다)
  const db: Db = createDb(poolBackend(pool));
  const env: Env = {
    ...cfg.env,
    DB: db,
    FILES: fsFileStore(cfg.filesDir),
    ...(o.pageCache ? { PAGE_CACHE: new MemoryPageCache() } : {}),
    RUNTIME: { filesDir: cfg.filesDir, backupDir: cfg.backupDir, startedAt: now(), schedulerOn: o.schedulerOn ?? cfg.schedulerOn },
  };
  return { pool, db, env };
}
