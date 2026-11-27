// 실행 상태 점검 (T-19, /admin/system). Cloudflare 바인딩 점검을 대신한다: DB 연결 · 마이그레이션 · 파일/백업 폴더 쓰기 · 디스크 여유 · 예약 작업 마지막 실행.
// runtimeChecks 는 순수 함수(모은 사실 → 점검 항목), gatherRuntimeFacts 가 DB·폴더를 실제로 본다. 경로·비밀값은 결과에 넣지 않는다 (숫자·코드만).
import { randomBytes } from 'node:crypto';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../env';
import { getSetting } from '../db/settings';
import { listAppliedMigrations, pingDb, PG_MIGRATIONS } from '../db/system';
import type { CheckLevel } from './config-check';
import { LAST_RUN_KEY, parseLastRun, type LastRun } from './scheduler';

export const RUNTIME_CHECK_IDS = ['db', 'migrations', 'data_dir', 'backup_dir', 'disk', 'scheduler'] as const;
export type RuntimeCheckId = (typeof RUNTIME_CHECK_IDS)[number];
export interface RuntimeCheckItem { id: RuntimeCheckId; level: CheckLevel; code: string; n?: number }

export type DirState = 'ok' | 'not_writable';

export interface RuntimeFacts {
  now: number;
  db: boolean;
  applied: string[] | null;
  /** 서버 실행 정보가 없으면(테스트) 폴더·디스크·예약 작업은 보지 않는다. */
  runtime: null | {
    filesDir: DirState;
    backupDir: DirState;
    /** 파일 폴더가 있는 디스크의 남은 바이트. 알 수 없으면 null. */
    diskFree: number | null;
    startedAt: number;
    schedulerOn: boolean;
    lastRun: LastRun | null;
  };
}

export const DISK_WARN_BYTES = 2 * 1024 ** 3;
export const DISK_PROBLEM_BYTES = 500 * 1024 ** 2;
/** 정각마다 도므로 마지막 실행이 이보다 오래되면 멈춘 것이다. */
export const SCHEDULER_LATE_SEC = 2 * 3600 + 600;

/** 순수 함수. expected = 이 코드가 기대하는 마이그레이션 목록. */
export function runtimeChecks(f: RuntimeFacts, expected: readonly string[] = PG_MIGRATIONS): RuntimeCheckItem[] {
  const out: RuntimeCheckItem[] = [];
  const add = (id: RuntimeCheckId, level: CheckLevel, code: string, n?: number) => out.push(n === undefined ? { id, level, code } : { id, level, code, n });

  add('db', f.db ? 'ok' : 'problem', f.db ? 'ok' : 'down');

  if (!f.db) add('migrations', 'problem', 'unknown');
  else if (f.applied === null) add('migrations', 'problem', 'none');
  else {
    const missing = expected.filter((m) => !f.applied!.includes(m)).length;
    const extra = f.applied.filter((m) => !expected.includes(m)).length;
    if (missing) add('migrations', 'problem', 'missing', missing);
    else if (extra) add('migrations', 'warning', 'newer', extra);
    else add('migrations', 'ok', 'ok', expected.length);
  }

  const r = f.runtime;
  if (!r) return out;
  add('data_dir', r.filesDir === 'ok' ? 'ok' : 'problem', r.filesDir);
  add('backup_dir', r.backupDir === 'ok' ? 'ok' : 'warning', r.backupDir);

  if (r.diskFree === null) add('disk', 'warning', 'unknown');
  else {
    const gb = Math.floor((r.diskFree / 1024 ** 3) * 10) / 10;
    if (r.diskFree < DISK_PROBLEM_BYTES) add('disk', 'problem', 'very_low', gb);
    else if (r.diskFree < DISK_WARN_BYTES) add('disk', 'warning', 'low', gb);
    else add('disk', 'ok', 'ok', gb);
  }

  if (!r.schedulerOn) add('scheduler', 'warning', 'off');
  else if (!r.lastRun) add('scheduler', f.now - r.startedAt > SCHEDULER_LATE_SEC ? 'problem' : 'ok', f.now - r.startedAt > SCHEDULER_LATE_SEC ? 'never' : 'waiting');
  else {
    const mins = Math.max(0, Math.floor((f.now - r.lastRun.finished_at) / 60));
    if (f.now - r.lastRun.at > SCHEDULER_LATE_SEC && f.now - r.startedAt > SCHEDULER_LATE_SEC) add('scheduler', 'problem', 'late', mins);
    else if (!r.lastRun.ok) add('scheduler', 'warning', 'failed', mins);
    else add('scheduler', 'ok', 'ok', mins);
  }
  return out;
}

/** 폴더에 파일을 만들고 지워 본다. 없으면 만든다. */
export async function dirWritable(dir: string): Promise<DirState> {
  try {
    await mkdir(dir, { recursive: true });
    const p = join(dir, `.write-test-${randomBytes(6).toString('hex')}`);
    await writeFile(p, 'ok', { flag: 'wx' });
    await rm(p, { force: true });
    return 'ok';
  } catch {
    return 'not_writable';
  }
}

export async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function gatherRuntimeFacts(env: Env, now: number): Promise<RuntimeFacts> {
  const db = await pingDb(env.DB);
  const applied = db ? await listAppliedMigrations(env.DB) : null;
  const rt = env.RUNTIME;
  if (!rt) return { now, db, applied, runtime: null };
  const [filesDir, backupDir, diskFree] = await Promise.all([dirWritable(rt.filesDir), dirWritable(rt.backupDir), diskFreeBytes(rt.filesDir)]);
  let lastRun: LastRun | null = null;
  if (db) {
    try {
      lastRun = parseLastRun(await getSetting(env.DB, LAST_RUN_KEY));
    } catch {
      lastRun = null;
    }
  }
  return { now, db, applied, runtime: { filesDir, backupDir, diskFree, startedAt: rt.startedAt, schedulerOn: rt.schedulerOn, lastRun } };
}
