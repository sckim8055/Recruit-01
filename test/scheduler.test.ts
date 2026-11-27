// 예약 작업 실행기 (T-19, src/lib/scheduler.ts) · 실행 상태 점검 (src/lib/system-check.ts).
import { describe, expect, it } from 'vitest';
import { hourStartSec, lastRunOf, msUntilNextHour, parseLastRun, Scheduler } from '../src/lib/scheduler';
import { runtimeChecks, RUNTIME_CHECK_IDS, SCHEDULER_LATE_SEC, type RuntimeFacts } from '../src/lib/system-check';
import { stepsForTime } from '../src/lib/maintenance';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 27, 4, 59, 59, 900); // 04:59:59.9 UTC

/** 가짜 시계·타이머. */
function fakeTime(start: number) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  return {
    nowMs: () => now,
    setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, id: ++id }; timers.push(t); return t.id; },
    clearTimer: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    /** ms 만큼 지나며 때가 된 타이머를 부른다. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('정각 계산', () => {
  it('다음 정각까지 남은 시간 · 지금 정각', () => {
    expect(msUntilNextHour(T0)).toBe(100);
    expect(msUntilNextHour(Date.UTC(2026, 0, 1, 3))).toBe(H);
    expect(hourStartSec(Date.UTC(2026, 0, 1, 3, 30))).toBe(Date.UTC(2026, 0, 1, 3) / 1000);
  });
});

describe('Scheduler', () => {
  it('정각마다 그 정각의 시각(초)으로 한 번 실행한다 — 시간표의 칸이 맞다', async () => {
    const t = fakeTime(T0);
    const runs: number[] = [];
    const s = new Scheduler({ run: async (h) => { runs.push(h); return { step: 'x', ok: true, done: {} }; }, ...t, log: () => {} });
    s.start();
    t.advance(200); // 05:00:00.1 → 정각 + 50ms 에 깨어남
    await tick();
    expect(runs).toEqual([Date.UTC(2026, 10, 27, 5) / 1000]);
    expect(stepsForTime(runs[0]!)).toEqual(['sweepOrphans']); // 05 UTC 칸
    t.advance(H);
    await tick();
    expect(runs.length).toBe(2);
    expect(runs[1]! - runs[0]!).toBe(3600);
    await s.stop();
    expect(t.pending()).toBe(0);
  });

  it('앞 실행이 아직 돌고 있으면 이번 정각은 건너뛴다 (쌓지 않는다)', async () => {
    let release!: () => void;
    const logs: string[] = [];
    let calls = 0;
    const s = new Scheduler({ run: () => { calls++; return new Promise((r) => { release = () => r({}); }); }, log: (l) => logs.push(l) });
    const first = s.fire(3600);
    await tick();
    expect(s.isRunning).toBe(true);
    expect(await s.fire(7200)).toBe(false);
    expect(logs).toEqual(['maint: skipped reason=previous_run_still_running']);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(s.isRunning).toBe(false);
  });

  it('다른 프로세스가 잠금을 잡고 있으면 실행하지 않는다, 잠금 오류도 건너뜀으로', async () => {
    const logs: string[] = [];
    let calls = 0;
    const locked = new Scheduler({ run: async () => { calls++; }, tryLock: async () => ({ acquired: false }), log: (l) => logs.push(l) });
    expect(await locked.fire(3600)).toBe(false);
    const broken = new Scheduler({ run: async () => { calls++; }, tryLock: async () => { throw new Error('db down'); }, log: (l) => logs.push(l) });
    expect(await broken.fire(3600)).toBe(false);
    expect(calls).toBe(0);
    expect(logs).toEqual(['maint: skipped reason=locked_by_other_process', 'maint: skipped reason=lock_error']);
  });

  it('잠금을 얻으면 실행 → 기록 → 추가 작업 순서, 기록·추가 작업이 실패해도 계속', async () => {
    const order: string[] = [];
    const s = new Scheduler({
      run: async () => { order.push('run'); return 'out'; },
      tryLock: async (fn) => { order.push('lock'); const v = await fn(); order.push('unlock'); return { acquired: true, value: v }; },
      record: async (_h, out) => { order.push(`record:${String(out)}`); throw new Error('x'); },
      after: () => { order.push('after'); throw new Error('y'); },
      log: () => {},
    });
    expect(await s.fire(3600)).toBe(true);
    expect(order).toEqual(['lock', 'run', 'record:out', 'unlock', 'after']);
  });

  it('stop(): 새 정각을 잡지 않고 돌고 있는 실행을 기다린다', async () => {
    const t = fakeTime(T0);
    let release!: () => void;
    let done = false;
    const s = new Scheduler({ run: () => new Promise((r) => { release = () => { done = true; r({}); }; }), ...t, log: () => {} });
    s.start();
    t.advance(200);
    await tick();
    const stopping = s.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await tick();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(done).toBe(true);
    expect(t.pending()).toBe(0);
  });

  it('마지막 실행 기록: 단계 이름·성공 여부만', () => {
    const r = lastRunOf(3600, 3700, { step: 'report', ok: true, done: { mail_sent: 1 }, also: [{ step: 'sendAlerts', ok: false, done: {} }] });
    expect(r).toEqual({ at: 3600, finished_at: 3700, ok: false, steps: ['report', 'sendAlerts'] });
    expect(parseLastRun(JSON.stringify(r))).toEqual(r);
    expect([parseLastRun(null), parseLastRun('x'), parseLastRun('{"at":"1"}')]).toEqual([null, null, null]);
  });
});

describe('실행 상태 점검 (runtimeChecks)', () => {
  const NOW = 1_800_000_000;
  const facts = (o: Partial<RuntimeFacts> = {}, rt: Partial<NonNullable<RuntimeFacts['runtime']>> = {}): RuntimeFacts => ({
    now: NOW, db: true, applied: ['0001_init.sql'],
    runtime: { filesDir: 'ok', backupDir: 'ok', diskFree: 50 * 1024 ** 3, startedAt: NOW - 86400, schedulerOn: true, lastRun: { at: NOW - 1800, finished_at: NOW - 1790, ok: true, steps: ['x'] }, ...rt },
    ...o,
  });
  const pick = (f: RuntimeFacts, id: string) => runtimeChecks(f, ['0001_init.sql']).find((c) => c.id === id)!;

  it('모두 정상', () => {
    const items = runtimeChecks(facts(), ['0001_init.sql']);
    expect(items.map((i) => i.id)).toEqual([...RUNTIME_CHECK_IDS]);
    expect(items.filter((i) => i.level !== 'ok')).toEqual([]);
    expect(pick(facts(), 'disk')).toMatchObject({ code: 'ok', n: 50 });
    expect(pick(facts(), 'scheduler')).toMatchObject({ code: 'ok', n: 29 });
  });
  it('DB 없음 · 기록 없음 · 빠진 파일 · 모르는 파일', () => {
    expect(pick(facts({ db: false, applied: null }), 'db').level).toBe('problem');
    expect(pick(facts({ db: false, applied: null }), 'migrations').code).toBe('unknown');
    expect(pick(facts({ applied: null }), 'migrations')).toMatchObject({ level: 'problem', code: 'none' });
    expect(pick(facts({ applied: [] }), 'migrations')).toMatchObject({ level: 'problem', code: 'missing', n: 1 });
    expect(pick(facts({ applied: ['0001_init.sql', '0002_x.sql'] }), 'migrations')).toMatchObject({ level: 'warning', code: 'newer', n: 1 });
  });
  it('폴더 · 디스크', () => {
    expect(pick(facts({}, { filesDir: 'not_writable' }), 'data_dir').level).toBe('problem');
    expect(pick(facts({}, { backupDir: 'not_writable' }), 'backup_dir').level).toBe('warning');
    expect(pick(facts({}, { diskFree: 1024 ** 3 }), 'disk')).toMatchObject({ level: 'warning', code: 'low' });
    expect(pick(facts({}, { diskFree: 100 * 1024 ** 2 }), 'disk')).toMatchObject({ level: 'problem', code: 'very_low' });
    expect(pick(facts({}, { diskFree: null }), 'disk').code).toBe('unknown');
  });
  it('예약 작업: 꺼짐 · 막 켜짐 · 기록 없음 · 늦음 · 실패', () => {
    expect(pick(facts({}, { schedulerOn: false }), 'scheduler')).toMatchObject({ level: 'warning', code: 'off' });
    expect(pick(facts({}, { lastRun: null, startedAt: NOW - 600 }), 'scheduler')).toMatchObject({ level: 'ok', code: 'waiting' });
    expect(pick(facts({}, { lastRun: null }), 'scheduler')).toMatchObject({ level: 'problem', code: 'never' });
    const old = { at: NOW - SCHEDULER_LATE_SEC - 1, finished_at: NOW - SCHEDULER_LATE_SEC, ok: true, steps: [] };
    expect(pick(facts({}, { lastRun: old }), 'scheduler')).toMatchObject({ level: 'problem', code: 'late' });
    expect(pick(facts({}, { lastRun: old, startedAt: NOW - 60 }), 'scheduler').level).toBe('ok'); // 막 다시 켠 서버는 기다린다
    expect(pick(facts({}, { lastRun: { at: NOW - 60, finished_at: NOW - 30, ok: false, steps: [] } }), 'scheduler')).toMatchObject({ level: 'warning', code: 'failed' });
  });
  it('서버 실행 정보가 없으면(테스트) DB·마이그레이션만', () => {
    expect(runtimeChecks(facts({ runtime: null }), ['0001_init.sql']).map((i) => i.id)).toEqual(['db', 'migrations']);
  });
  it('모든 결과 코드에 한국어·중국어 문구가 있고, 경로·비밀값은 결과에 없다', () => {
    const variants: RuntimeFacts[] = [
      facts(), facts({ db: false, applied: null }), facts({ applied: null }), facts({ applied: [] }), facts({ applied: ['0001_init.sql', 'z'] }),
      facts({}, { filesDir: 'not_writable', backupDir: 'not_writable', diskFree: null, schedulerOn: false }), facts({}, { diskFree: 1 }), facts({}, { diskFree: 1024 ** 3 }),
      facts({}, { lastRun: null }), facts({}, { lastRun: null, startedAt: NOW }), facts({}, { lastRun: { at: 0, finished_at: 0, ok: false, steps: [] } }),
      facts({}, { lastRun: { at: NOW, finished_at: NOW, ok: false, steps: [] } }),
    ];
    const keys = new Set<string>();
    for (const v of variants) for (const c of runtimeChecks(v, ['0001_init.sql'])) keys.add(`sys.res.${c.id}.${c.code}`);
    for (const id of RUNTIME_CHECK_IDS) keys.add(`sys.chk.${id}`);
    expect([...keys].filter((k) => !(k in ko) || !(k in zh))).toEqual([]);
    expect(JSON.stringify(variants.map((v) => runtimeChecks(v)))).not.toMatch(/[\\/]/);
  });
});
