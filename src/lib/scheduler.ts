// 예약 작업 실행기 (T-19). Cloudflare cron("0 * * * *") 대신 서버 프로세스 안에서 **매시 정각**에 runMaintenance 를 부른다.
// 하는 일·시간표(SCHEDULE·SHARED_SLOTS)·로그 줄(`maint: step=…`)은 lib/maintenance.ts 그대로다. 여기서는 언제 부를지만 정한다.
//
// - 정각 계산: 다음 정각까지 기다렸다가 그 정각의 시각(초)으로 실행한다 (cron 의 scheduledTime 과 같다). 타이머가 조금 늦게 깨어나도
//   시간표의 칸은 그 정각으로 정한다. PC 가 잠들어 있던 동안의 정각은 건너뛴다 (밀린 것을 몰아서 하지 않는다 — 다음 정각부터).
// - 겹치지 않기: 앞 실행이 아직 돌고 있으면 이번 정각은 건너뛴다(쌓지 않는다). 두 프로세스가 같은 DB 를 쓰면 PostgreSQL 권고 잠금
//   (db/locks.withAdvisoryLock)을 얻은 쪽만 실행한다. 건너뛰면 `maint: skipped reason=…` 한 줄.
// - 끝나면 site_settings 'maint.last_run' 에 {at, ok, steps} 를 남긴다 (/admin/system 이 보여 준다). 개인정보 없음.
// - stop(): 새 정각을 더 잡지 않고, 돌고 있는 실행이 끝나기를 기다린다 (서버 종료 때).
import type { LockResult } from '../db/locks';

export interface SchedulerDeps {
  /** 한 번 실행 (예외를 던지지 않는 runMaintenance). 돌려주는 값은 record 에 넘긴다. */
  run(hourSec: number): Promise<unknown>;
  /** 프로세스 사이 잠금. 없으면 이 프로세스 안에서만 겹치지 않게 한다. */
  tryLock?<T>(fn: () => Promise<T>): Promise<LockResult<T>>;
  /** 실행 뒤 기록 (실패해도 무시). */
  record?(hourSec: number, outcome: unknown): Promise<void>;
  /** 정각에 실행 뒤 추가로 할 일 (자동 백업 등). 예외는 무시한다. */
  after?(hourSec: number): Promise<void> | void;
  nowMs?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (line: string) => void;
}

/** 다음 정각까지 남은 밀리초 (정각이면 1시간 뒤). 순수 함수. */
export const msUntilNextHour = (nowMs: number): number => 3_600_000 - (nowMs % 3_600_000);
/** 지금 시각이 속한 정각 (초). */
export const hourStartSec = (nowMs: number): number => Math.floor(nowMs / 3_600_000) * 3600;

export class Scheduler {
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private readonly d: Required<Omit<SchedulerDeps, 'tryLock' | 'record' | 'after'>> & Pick<SchedulerDeps, 'tryLock' | 'record' | 'after'>;

  constructor(deps: SchedulerDeps) {
    this.d = {
      nowMs: Date.now,
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: (l) => console.log(l),
      ...deps,
    };
  }

  get isRunning(): boolean { return this.running !== null; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    // 정각 바로 뒤(밀리초 오차)에 깨어나도록 +50ms.
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.fire(hourStartSec(this.d.nowMs()));
      this.arm();
    }, msUntilNextHour(this.d.nowMs()) + 50);
  }

  /** 정각 하나를 실행한다 (테스트·수동 실행도 이것을 쓴다). 건너뛰면 false. */
  async fire(hourSec: number): Promise<boolean> {
    if (this.running) {
      this.d.log('maint: skipped reason=previous_run_still_running');
      return false;
    }
    let done!: () => void;
    this.running = new Promise<void>((r) => { done = r; });
    try {
      const body = async () => {
        const out = await this.d.run(hourSec);
        try {
          await this.d.record?.(hourSec, out);
        } catch {
          /* 기록 실패는 무시 */
        }
        return out;
      };
      const res = this.d.tryLock ? await this.d.tryLock(body) : { acquired: true as const, value: await body() };
      if (!res.acquired) {
        this.d.log('maint: skipped reason=locked_by_other_process');
        return false;
      }
      try {
        await this.d.after?.(hourSec);
      } catch {
        /* 추가 작업 실패는 무시 (그쪽이 로그를 남긴다) */
      }
      return true;
    } catch {
      this.d.log('maint: skipped reason=lock_error');
      return false;
    } finally {
      this.running = null;
      done();
    }
  }

  /** 새 정각을 잡지 않고, 돌고 있는 실행을 기다린다. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.d.clearTimer(this.timer);
      this.timer = null;
    }
    const r = this.running;
    if (r) await r;
  }
}

/** 'maint.last_run' 에 남기는 값 (개수·이름만). */
export interface LastRun { at: number; finished_at: number; ok: boolean; steps: string[] }
export const LAST_RUN_KEY = 'maint.last_run';

/** runMaintenance 결과 → LastRun. */
export function lastRunOf(hourSec: number, finishedSec: number, outcome: unknown): LastRun {
  const o = outcome as { step?: string; ok?: boolean; also?: Array<{ step?: string; ok?: boolean }> } | null;
  const all = o ? [o, ...(o.also ?? [])] : [];
  return { at: hourSec, finished_at: finishedSec, ok: all.length > 0 && all.every((x) => x.ok === true), steps: all.map((x) => String(x.step ?? '')) };
}

export function parseLastRun(raw: string | null): LastRun | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastRun>;
    if (typeof v.at !== 'number' || typeof v.ok !== 'boolean') return null;
    return { at: v.at, finished_at: typeof v.finished_at === 'number' ? v.finished_at : v.at, ok: v.ok, steps: Array.isArray(v.steps) ? v.steps.map(String) : [] };
  } catch {
    return null;
  }
}
