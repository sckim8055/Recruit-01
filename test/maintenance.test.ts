// T-12 예약 작업: 단계마다 경계(기한 정각·1초 전후), 건드리면 안 되는 행, 두 번 실행, 상한, 순서(D1 먼저 → R2), 규칙 3(상태는 이벤트와 함께),
// 보관 기간 상수 = 개인정보처리방침 글, 시간표·실행기. SQLite 메모리 DB(외래키 켬 — D1 과 같게) + 가짜 R2.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsx } from 'hono/jsx';
import type { Env } from '../src/env';
import { PRIVACY } from '../src/legal/privacy';
import {
  ACCESS_LOG_KEEP, APPLICATION_AUTO_CLOSE_AFTER, APPLICATION_KEEP_AFTER_CLOSE, DAY, EMAIL_LOG_KEEP, ERASED_ROW_KEEP, HOUR,
  JOB_CLOSE_NOTICE_BEFORE, JOB_STALE_AFTER, ORPHAN_MIN_AGE, PRIVACY_TEXT_NUMBERS, VDOC_KEEP_AFTER_REVIEW,
} from '../src/lib/retention';
import {
  AUTO_CLOSABLE, BUDGET, CAPS, ORPHAN_CURSOR_KEY, REPORT_HOUR_UTC, SCHEDULE, STEP_NAMES, STEPS, autoCloseGroups, closeDateOf, devForcedStep,
  jobCloseNoticeMail, mergeStats, parseStats, pickOrphans, planNotices, reportText, runMaintenance, statsKey, stepForTime, type StepName,
} from '../src/lib/maintenance';
import { WITHDRAWABLE } from '../src/lib/application';
import { USAGE_KEEP_DAYS, kstDay } from '../src/lib/quota';
import { verifyBlocks } from '../src/lib/rules';
import { t } from '../src/lib/i18n';
import { identitySnapshot } from '../src/lib/company';
import { saveKorean } from '../src/db/jobs';
import { findPublicCompany, loadCompanyDetail } from '../src/db/companies';
import { AdminCompanyDetail } from '../src/views/admin-company';
import { hasSqlite, migratedDb } from './sqlite-d1';

// 2027-01-15 08:00:00 UTC (정각)
const NOW = 1_800_000_000 - (1_800_000_000 % 3600);
const ORIGIN = 'https://recruit.example.test';

type Raw = ReturnType<typeof migratedDb>['raw'];

// ── 가짜 R2: 키 → 올라온 시각. list 는 prefix·limit·cursor(마지막 키 다음부터)를 흉내 낸다. 호출 수를 센다.
function fakeR2() {
  const objs = new Map<string, Date>();
  const st = { ops: 0, failDelete: false, failList: false, onDelete: null as null | ((k: string) => void), deleted: [] as string[] };
  const bucket = {
    async list(o: { prefix?: string; limit?: number; cursor?: string }) {
      st.ops++;
      if (st.failList) throw new Error('r2 list down');
      const keys = [...objs.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort().filter((k) => !o.cursor || k > o.cursor);
      const page = keys.slice(0, o.limit ?? 1000);
      const truncated = keys.length > page.length;
      return { objects: page.map((key) => ({ key, uploaded: objs.get(key)! })), truncated, ...(truncated ? { cursor: page[page.length - 1] } : {}), delimitedPrefixes: [] };
    },
    async delete(k: string) {
      st.ops++;
      st.onDelete?.(k);
      if (st.failDelete) throw new Error('r2 delete down');
      st.deleted.push(k);
      objs.delete(k);
    },
    async put(k: string) { st.ops++; objs.set(k, new Date(NOW * 1000)); return {}; },
  };
  return { objs, st, bucket };
}

// ── D1 문장 수 세기 (batch 안의 문장도 하나씩 센다)
function counted(d1: D1Database) {
  const c = { n: 0, failOn: null as RegExp | null };
  const db = {
    prepare(sql: string) {
      const s = d1.prepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown> & { sql: string };
      for (const m of ['first', 'all', 'run'] as const) {
        const orig = s[m]!.bind(s);
        s[m] = (...a: unknown[]) => { c.n++; if (c.failOn?.test(sql)) throw new Error('db down'); return orig(...a); };
      }
      return s;
    },
    batch(stmts: Array<{ sql: string }>) {
      c.n += stmts.length;
      if (stmts.some((x) => c.failOn?.test(x.sql))) return Promise.reject(new Error('db down'));
      return d1.batch(stmts as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  return { db, c };
}

function setup(o: { ops?: string } = {}) {
  const { raw, d1 } = migratedDb();
  raw.exec('PRAGMA foreign_keys = ON');
  const r2 = fakeR2();
  const cnt = counted(d1);
  const env = {
    DB: cnt.db, FILES: r2.bucket, APP_ENV: 'dev', APP_ORIGIN: ORIGIN, MAIL_FROM: '', OPS_EMAIL: o.ops ?? '',
  } as unknown as Env;
  return { raw, d1, env, r2, cnt };
}

const q = (raw: Raw, sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[]));
const one = (raw: Raw, sql: string, ...a: unknown[]) => raw.prepare(sql).get(...(a as never[])) as Record<string, unknown> | undefined;
const num = (raw: Raw, sql: string, ...a: unknown[]) => Number(Object.values(one(raw, sql, ...a) ?? { n: 0 })[0]);

let seq = 0;
const id = (p: string) => `${p}-${String(++seq).padStart(4, '0')}`;

function user(raw: Raw, role = 'seeker', status = 'active'): string {
  const u = id('u');
  raw.prepare('INSERT INTO users (id, email, role, status, created_at) VALUES (?,?,?,?,0)').run(u, `${u}@example.test`, role, status);
  return u;
}
function company(raw: Raw, members: Array<{ status?: string }> = [{}], verify = 'verified'): { co: string; members: string[] } {
  const co = id('co');
  raw.prepare("INSERT INTO companies (id, name_ko, entity_type, biz_no, verify_status, verified_at, created_at) VALUES (?,?, 'kr_entity', '1234567891', ?, 0, 0)").run(co, `기업 ${co}`, verify);
  const ms = members.map((m, i) => {
    const u = user(raw, 'company', m.status ?? 'active');
    raw.prepare('INSERT INTO company_members (company_id, user_id, member_role, created_at) VALUES (?,?,?,?)').run(co, u, i === 0 ? 'owner' : 'member', i);
    return u;
  });
  return { co, members: ms };
}
function job(raw: Raw, co: string, by: string, o: { status?: string; closes_at?: number | null; updated_at?: number; notice?: number | null; title?: string } = {}): string {
  const j = id('job');
  raw.prepare(
    `INSERT INTO jobs (id, company_id, created_by, title_ko, body_ko, status, closes_at, close_notice_at, created_at, updated_at, published_at, localize_status)
     VALUES (?,?,?,?,?,?,?,?,0,?,0,'approved')`,
  ).run(j, co, by, o.title ?? `공고 ${j}`, '본문', o.status ?? 'published', o.closes_at ?? null, o.notice ?? null, o.updated_at ?? NOW);
  return j;
}
function app(raw: Raw, jobId: string, o: { status?: string; purge?: number | null; snapshot?: string; file?: string | null; seeker?: string } = {}): string {
  const a = id('app');
  const s = o.seeker ?? user(raw);
  raw.prepare(
    `INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, file_r2_key, status, status_changed_at, created_at, purge_after, summary_zh)
     VALUES (?,?,?,?,?,?,0,0,?,?)`,
  ).run(a, jobId, s, o.snapshot ?? 'v1.cipher', o.file ?? null, o.status ?? 'submitted', o.purge ?? null, o.snapshot === '' ? null : 'v1.zh');
  return a;
}
const appRow = (raw: Raw, a: string) => one(raw, 'SELECT * FROM applications WHERE id = ?', a)!;
const events = (raw: Raw, a: string) => q(raw, 'SELECT event, actor_id, at FROM application_events WHERE application_id = ?', a);

// ── 콘솔: sendMail 의 dev 출력과 maint: 로그 줄을 모은다
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());
const mailLogs = () => logs.filter((l) => l.startsWith('[mail:'));
const maintLogs = () => logs.filter((l) => l.startsWith('maint:'));

// ───────────────────────── 보관 기간 = 개인정보처리방침

describe('보관 기간 상수', () => {
  it('숫자', () => {
    expect(APPLICATION_KEEP_AFTER_CLOSE).toBe(180 * DAY);
    expect(APPLICATION_AUTO_CLOSE_AFTER).toBe(30 * DAY);
    expect(VDOC_KEEP_AFTER_REVIEW).toBe(365 * DAY);
    expect(ACCESS_LOG_KEEP).toBe(730 * DAY);
    expect(ERASED_ROW_KEEP).toBe(730 * DAY);
    expect(EMAIL_LOG_KEEP).toBe(365 * DAY);
    expect(JOB_STALE_AFTER).toBe(30 * DAY);
    expect(JOB_CLOSE_NOTICE_BEFORE).toBe(3 * DAY);
    expect(ORPHAN_MIN_AGE).toBe(24 * HOUR);
  });
  it('개인정보처리방침 3항(한국어·중국어)에 같은 숫자가 있다', () => {
    const sec = (l: 'ko' | 'zh') => PRIVACY[l].sections.find((s) => s.h.startsWith('3.'))!.items;
    const ko = sec('ko'), zh = sec('zh');
    const find = (items: string[], word: string) => items.find((x) => x.startsWith(word)) ?? '';
    // 숫자를 상수에서 만들어 글과 비교한다
    expect(find(ko, '지원서(')).toContain(`중단된 뒤 ${APPLICATION_KEEP_AFTER_CLOSE / DAY}일`);
    expect(find(ko, '지원서(')).toContain(`마감 후 ${APPLICATION_AUTO_CLOSE_AFTER / DAY}일`);
    expect(`${APPLICATION_KEEP_AFTER_CLOSE / DAY}일`).toBe(PRIVACY_TEXT_NUMBERS.ko.application);
    expect(find(ko, '기업의 사업자 서류')).toContain(`확인 후 ${VDOC_KEEP_AFTER_REVIEW / (365 * DAY)}년`);
    expect(find(ko, '지원서·서류의 열람 기록')).toContain(`${ACCESS_LOG_KEEP / (365 * DAY)}년`);
    expect(find(ko, '동의 기록')).toContain(`${ERASED_ROW_KEEP / (365 * DAY)}년간`);
    expect(find(zh, '应聘资料（')).toContain(`停止发布后${APPLICATION_KEEP_AFTER_CLOSE / DAY}天`);
    expect(find(zh, '应聘资料（')).toContain(`截止后${APPLICATION_AUTO_CLOSE_AFTER / DAY}天`);
    expect(find(ko, '메일 발송 기록')).toContain(`${EMAIL_LOG_KEEP / (365 * DAY)}년`);
    expect(find(zh, '企业的营业资料')).toContain(`确认后${VDOC_KEEP_AFTER_REVIEW / (365 * DAY)}年`);
    expect(find(zh, '应聘资料和企业资料的查看记录')).toContain(`${ACCESS_LOG_KEEP / (365 * DAY)}年`);
    expect(find(zh, '同意记录')).toContain(`${ERASED_ROW_KEEP / (365 * DAY)}年`);
  });
});

// ───────────────────────── 순수 도우미

describe('도우미', () => {
  it('자동 종료 대상 상태 = 진행 중인 상태 (취소할 수 있는 상태와 같다)', () => {
    expect(AUTO_CLOSABLE).toEqual(['submitted', 'viewed', 'reviewing', 'interview']);
    expect(AUTO_CLOSABLE).toEqual(WITHDRAWABLE);
  });
  it('autoCloseGroups: 상태별로 묶고 끝난 상태는 뺀다', () => {
    const g = autoCloseGroups([
      { id: 'a', status: 'submitted' }, { id: 'b', status: 'viewed' }, { id: 'c', status: 'submitted' },
      { id: 'd', status: 'rejected' }, { id: 'e', status: 'withdrawn' }, { id: 'f', status: 'closed' }, { id: 'g', status: 'weird' },
    ]);
    expect(g).toEqual([{ from: 'submitted', to: 'closed', ids: ['a', 'c'] }, { from: 'viewed', to: 'closed', ids: ['b'] }]);
  });
  it('pickOrphans: rfiles/ · 24시간 이상 · 참조 없음 · 상한', () => {
    const at = (s: number) => new Date(s * 1000);
    const objs = [
      { key: 'rfiles/old', uploaded: at(NOW - ORPHAN_MIN_AGE - 1) },
      { key: 'rfiles/exact', uploaded: at(NOW - ORPHAN_MIN_AGE) },
      { key: 'rfiles/young', uploaded: at(NOW - ORPHAN_MIN_AGE + 1) },
      { key: 'rfiles/ref', uploaded: at(0) },
      { key: 'vdocs/company/x/y.pdf', uploaded: at(0) },
      { key: 'other/z', uploaded: at(0) },
      { key: 'rfiles/bad-date', uploaded: new Date('x') },
    ];
    expect(pickOrphans(objs, new Set(['rfiles/ref']), NOW, 10)).toEqual(['rfiles/old', 'rfiles/exact']);
    expect(pickOrphans(objs, new Set(), NOW, 1)).toEqual(['rfiles/old']);
  });
  it('planNotices: 메일 상한을 넘기 전까지, 담당자 없는 공고는 메일 없이', () => {
    const jobs = [{ id: '1', company_id: 'A' }, { id: '2', company_id: 'B' }, { id: '3', company_id: 'C' }, { id: '4', company_id: 'A' }];
    const em = new Map([['A', ['a1', 'a2', 'a3', 'a4']], ['C', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']]]);
    expect(planNotices(jobs, em, 10).map((p) => [p.job.id, p.to.length])).toEqual([['1', 4], ['2', 0]]);
    expect(planNotices(jobs, em, 11).map((p) => p.job.id)).toEqual(['1', '2', '3']);
  });
  it('안내 메일: 한국어·중국어, 날짜, 개인정보 없음, 금지 표현 없음', () => {
    const dl = jobCloseNoticeMail({ title_ko: '영업\n담당', closes_at: NOW + 2 * DAY, updated_at: 0 }, NOW, ORIGIN, (l, k) => t(l, k));
    expect(dl.subject).toContain('공고 자동 마감 예정: 영업 담당');
    expect(dl.subject).toContain('职位即将自动截止');
    expect(dl.text).toContain('마감일(2027-01-17)');
    expect(dl.text).toContain('截止日期（2027-01-17）');
    expect(dl.text).toContain(`${ORIGIN}/biz/jobs`);
    expect(dl.text).not.toMatch(/@|취업(상담|추천|지원|알선)/);
    const st = jobCloseNoticeMail({ title_ko: 'x', closes_at: null, updated_at: NOW - 28 * DAY }, NOW, ORIGIN, (l, k) => t(l, k));
    expect(st.text).toContain('30일 동안 저장');
    expect(st.text).toContain('2027-01-18 이후'); // 마지막 저장 + 30일 = NOW + 2일 < NOW + 3일 → 3일 뒤
    expect(closeDateOf({ closes_at: null, updated_at: NOW - DAY }, NOW)).toBe(NOW + 29 * DAY);
  });
  it('집계: 숫자만 더한다, 잘못된 값은 버린다', () => {
    let s = mergeStats({}, 'closeJobs', true, { closed_deadline: 2 });
    s = mergeStats(s, 'closeJobs', false, { closed_deadline: 1 });
    expect(s).toEqual({ closeJobs: { runs: 2, failed: 1, closed_deadline: 3 } });
    expect(parseStats(JSON.stringify(s))).toEqual(s);
    expect(parseStats('nope')).toEqual({});
    expect(parseStats('[1]')).toEqual({});
    expect(parseStats('{"a":{"x":"y","n":1}}')).toEqual({ a: { n: 1 } });
  });
  it('개발용 단계 고르기: maint:<단계> 만', () => {
    expect(devForcedStep('maint:closeJobs')).toBe('closeJobs');
    expect(devForcedStep('0 * * * *')).toBeUndefined();
    expect(devForcedStep('maint:nope')).toBeUndefined();
    expect(devForcedStep(undefined)).toBeUndefined();
  });
});

// ───────────────────────── 시간표·실행기

describe('시간표', () => {
  it('24시간 모두 정해져 있고 문서와 같다', () => {
    const expected: StepName[] = [
      'report', 'closeJobs', 'markApplications', 'purgeApplications', 'dropOldRows', 'sweepOrphans', 'purgeVerificationDocs',
      'closeJobs', 'markApplications', 'purgeApplications', 'dropOldRows', 'sweepOrphans',
      'closeJobs', 'markApplications', 'purgeApplications', 'purgeVerificationDocs', 'sweepOrphans',
      'closeJobs', 'markApplications', 'purgeApplications', 'dropOldRows', 'sweepOrphans', 'closeJobs', 'purgeApplications',
    ];
    expect(SCHEDULE).toEqual(expected);
    const day = Math.floor(NOW / DAY) * DAY;
    for (let h = 0; h < 24; h++) {
      expect(stepForTime(day + h * HOUR), `hour ${h}`).toBe(expected[h]);
      expect(stepForTime(day + h * HOUR + 3599), `hour ${h} end`).toBe(expected[h]);
    }
    const count = (s: StepName) => SCHEDULE.filter((x) => x === s).length;
    expect(count('report')).toBe(1);
    expect(SCHEDULE[REPORT_HOUR_UTC]).toBe('report');
    expect(count('closeJobs')).toBeGreaterThanOrEqual(4);
    expect(count('purgeApplications')).toBeGreaterThanOrEqual(4);
    for (const s of STEP_NAMES) expect(count(s), s).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasSqlite)('실행기', () => {
  it('시각에 맞는 단계를 실행하고 로그 한 줄·집계를 남긴다', async () => {
    const { env, raw } = setup();
    const ran: StepName[] = [];
    const impl = Object.fromEntries(STEP_NAMES.map((s) => [s, async () => { ran.push(s); return { step: s, done: { x: 1 } }; }]));
    const day = Math.floor(NOW / DAY) * DAY;
    for (let h = 0; h < 24; h++) {
      const out = await runMaintenance(env, day + h * HOUR, { impl });
      expect(out.step).toBe(SCHEDULE[h]);
      expect(out.ok).toBe(true);
    }
    expect(ran).toEqual([...SCHEDULE]);
    expect(maintLogs()).toHaveLength(24);
    expect(maintLogs()[1]).toBe('maint: step=closeJobs ok counts={"x":1}');
    const stats = parseStats(one(raw, 'SELECT value FROM site_settings WHERE key = ?', statsKey(day))!.value as string);
    expect(stats.closeJobs).toEqual({ runs: 5, x: 5 });
    expect(stats.report).toEqual({ runs: 1, x: 1 });
  });
  it('단계가 예외를 던져도 실행기는 끝나고 failed 로 남긴다 (오류 내용은 로그에 없다)', async () => {
    const { env, raw } = setup();
    const out = await runMaintenance(env, NOW, { force: 'sweepOrphans', impl: { sweepOrphans: async () => { throw new Error('secret rfiles/abc a@b.test'); } } });
    expect(out).toEqual({ step: 'sweepOrphans', ok: false, done: {} });
    expect(maintLogs()).toEqual(['maint: step=sweepOrphans failed counts={}']);
    expect(logs.join('\n')).not.toMatch(/secret|rfiles|@/);
    expect(parseStats(one(raw, 'SELECT value FROM site_settings WHERE key = ?', statsKey(NOW))!.value as string).sweepOrphans).toEqual({ runs: 1, failed: 1 });
  });
  it('집계 저장이 실패해도 예외가 나가지 않는다', async () => {
    const { env, cnt } = setup();
    cnt.c.failOn = /site_settings/;
    const out = await runMaintenance(env, NOW, { force: 'dropOldRows' });
    expect(out.ok).toBe(true);
  });
  it('실제 단계 모두: 빈 DB 에서 실패 없이 돈다, 로그 줄에 이메일·키가 없다', async () => {
    const { env } = setup({ ops: 'ops@example.test' });
    for (const s of STEP_NAMES) expect((await runMaintenance(env, NOW, { force: s })).ok, s).toBe(true);
    expect(maintLogs()).toHaveLength(STEP_NAMES.length);
    for (const l of maintLogs()) expect(l).toMatch(/^maint: step=\w+ ok counts=\{("[a-z_]+":\d+,?)*\}$/);
  });
});

// ───────────────────────── 1. closeJobs

describe.skipIf(!hasSqlite)('closeJobs', () => {
  it('마감일: 지금과 같거나 지난 게재 중 공고만 마감, 초안·차단·마감은 그대로, 게재는 하지 않는다', async () => {
    const { raw, env } = setup();
    const { co, members } = company(raw);
    const by = members[0]!;
    const past = job(raw, co, by, { closes_at: NOW - 1 });
    const exact = job(raw, co, by, { closes_at: NOW });
    const future = job(raw, co, by, { closes_at: NOW + 1 });
    const draft = job(raw, co, by, { status: 'draft', closes_at: NOW - 100 });
    const blocked = job(raw, co, by, { status: 'blocked', closes_at: NOW - 100 });
    const r = await STEPS.closeJobs(env, NOW);
    expect(r.done.closed_deadline).toBe(2);
    const st = (j: string) => one(raw, 'SELECT status, updated_at FROM jobs WHERE id = ?', j)!;
    expect(st(past)).toEqual({ status: 'closed', updated_at: NOW });
    expect(st(exact).status).toBe('closed');
    expect(st(future).status).toBe('published');
    expect(st(draft).status).toBe('draft');
    expect(st(blocked).status).toBe('blocked');
    expect((await STEPS.closeJobs(env, NOW)).done.closed_deadline).toBe(0);
    expect(num(raw, "SELECT COUNT(*) FROM jobs WHERE status = 'published'")).toBe(1);
  });

  it('무수정 30일: 마감일 없음 + 안내 후 3일이 지난 것만 마감', async () => {
    const { raw, env } = setup();
    const { co, members } = company(raw, []);
    const by = user(raw, 'company');
    void members;
    const ok = job(raw, co, by, { updated_at: NOW - JOB_STALE_AFTER - 1, notice: NOW - 3 * DAY });
    const notStaleYet = job(raw, co, by, { updated_at: NOW - JOB_STALE_AFTER, notice: NOW - 3 * DAY });
    const noticeTooRecent = job(raw, co, by, { updated_at: NOW - 40 * DAY, notice: NOW - 3 * DAY + 1 });
    const noNotice = job(raw, co, by, { updated_at: NOW - 40 * DAY, notice: null });
    const draft = job(raw, co, by, { status: 'draft', updated_at: 0, notice: 0 });
    const withDeadline = job(raw, co, by, { closes_at: NOW + 10 * DAY, updated_at: 0, notice: 0 });
    const r = await STEPS.closeJobs(env, NOW);
    expect(r.done.closed_stale).toBe(1);
    const st = (j: string) => one(raw, 'SELECT status FROM jobs WHERE id = ?', j)!.status;
    expect(st(ok)).toBe('closed');
    for (const j of [notStaleYet, noticeTooRecent, noNotice, withDeadline]) expect(st(j)).toBe('published');
    expect(st(draft)).toBe('draft');
    // 안내가 없던 공고는 이번에 안내만 받는다 (담당자가 없으니 메일 없이 표시)
    expect(r.done.noticed).toBe(1);
    expect(one(raw, 'SELECT close_notice_at FROM jobs WHERE id = ?', noNotice)!.close_notice_at).toBe(NOW);
  });

  it('안내: 마감 3일 전·무수정 27일, 활성 담당자에게만 한 번, 저장하면 다시 안내', async () => {
    const { raw, env, d1 } = setup();
    const a = company(raw, [{}, {}, { status: 'suspended' }]);
    const b = company(raw, [{}]);
    const by = a.members[0]!;
    const dl = job(raw, a.co, by, { closes_at: NOW + JOB_CLOSE_NOTICE_BEFORE, title: '마감 공고' });
    const dlLater = job(raw, a.co, by, { closes_at: NOW + JOB_CLOSE_NOTICE_BEFORE + 1 });
    const stale = job(raw, b.co, b.members[0]!, { updated_at: NOW - (JOB_STALE_AFTER - JOB_CLOSE_NOTICE_BEFORE) - 1 });
    const staleNotYet = job(raw, b.co, b.members[0]!, { updated_at: NOW - (JOB_STALE_AFTER - JOB_CLOSE_NOTICE_BEFORE) });
    const draft = job(raw, a.co, by, { status: 'draft', closes_at: NOW + DAY });
    const r = await STEPS.closeJobs(env, NOW);
    expect(r.done).toMatchObject({ noticed: 2, mails_sent: 3, mails_failed: 0 });
    const notice = (j: string) => one(raw, 'SELECT close_notice_at FROM jobs WHERE id = ?', j)!.close_notice_at;
    expect(notice(dl)).toBe(NOW);
    expect(notice(stale)).toBe(NOW);
    for (const j of [dlLater, staleNotYet, draft]) expect(notice(j)).toBeNull();
    const to = mailLogs().map((l) => /to=(\S+)/.exec(l)![1]).sort();
    expect(to).toEqual([`${a.members[0]}@example.test`, `${a.members[1]}@example.test`, `${b.members[0]}@example.test`].sort());
    expect(num(raw, "SELECT COUNT(*) FROM email_log WHERE template = 'job_close_notice'")).toBe(3);
    // 두 번째 실행: 더 보내지 않는다
    logs = [];
    expect((await STEPS.closeJobs(env, NOW)).done).toMatchObject({ noticed: 0, mails_sent: 0 });
    expect(mailLogs()).toEqual([]);
    // 기업이 저장하면 close_notice_at 이 지워져 기간이 새로 시작된다
    const row = one(raw, 'SELECT rev, status FROM jobs WHERE id = ?', stale)!;
    const plan = { status: 'published', localize_status: 'approved', review_flag: null, review_cleared_by: null };
    expect(await saveKorean(d1, { title_ko: 't', body_ko: 'b', back_zh: null, plan, ts: NOW + 2 * HOUR, id: stale, rev: Number(row.rev), readStatus: 'published' })).toBe(true);
    expect(notice(stale)).toBeNull();
    await STEPS.closeJobs(env, NOW + 3 * HOUR);
    expect(notice(stale)).toBeNull(); // 방금 저장했으니 무수정 27일이 아니다 (다른 두 공고는 시간이 지나 이번에 안내된다)
    expect(notice(dlLater)).toBe(NOW + 3 * HOUR);
    expect(notice(staleNotYet)).toBe(NOW + 3 * HOUR);
  });

  it('상한: 마감 10건씩, 메일 10통씩 (넘는 것은 다음 차례)', async () => {
    const { raw, env } = setup();
    const { co, members } = company(raw, [{}, {}, {}, {}]);
    for (let i = 0; i < 15; i++) job(raw, co, members[0]!, { closes_at: NOW - i - 1 });
    for (let i = 0; i < 3; i++) job(raw, co, members[0]!, { closes_at: NOW + DAY + i });
    const r1 = await STEPS.closeJobs(env, NOW);
    expect(r1.done).toMatchObject({ closed_deadline: 10, closed_stale: 0, noticed: 2, mails_sent: 8 });
    const r2 = await STEPS.closeJobs(env, NOW + 1);
    expect(r2.done).toMatchObject({ closed_deadline: 5, noticed: 1, mails_sent: 4 });
    expect((await STEPS.closeJobs(env, NOW + 2)).done).toMatchObject({ closed_deadline: 0, noticed: 0, mails_sent: 0 });
  });

  it('그사이 기업이 저장한 공고는 안내 표시를 하지 않는다', async () => {
    const { raw, env, cnt } = setup();
    const { co, members } = company(raw);
    const j = job(raw, co, members[0]!, { closes_at: NOW + DAY });
    // 메일 기록(email_log)을 쓰는 순간에 공고가 저장된 것처럼 updated_at 을 바꾼다
    const origPrepare = cnt.db.prepare.bind(cnt.db);
    (cnt.db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (s.startsWith('INSERT INTO email_log')) raw.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(NOW + 5, j);
      return origPrepare(s);
    };
    const r = await STEPS.closeJobs(env, NOW + 10);
    expect(r.done).toMatchObject({ mails_sent: 1, noticed: 0 });
    expect(one(raw, 'SELECT close_notice_at FROM jobs WHERE id = ?', j)!.close_notice_at).toBeNull();
  });
});

// ───────────────────────── 2. markApplications

describe.skipIf(!hasSqlite)('markApplications', () => {
  function world(raw: Raw) {
    const { co, members } = company(raw);
    const by = members[0]!;
    return {
      closed: job(raw, co, by, { status: 'closed' }), blocked: job(raw, co, by, { status: 'blocked' }),
      published: job(raw, co, by), draft: job(raw, co, by, { status: 'draft' }),
    };
  }

  it('마감·차단 공고의 지원에 기한을 붙인다 (취소·게재 중·이미 기한 있는 것은 그대로)', async () => {
    const { raw, env } = setup();
    const w = world(raw);
    const a1 = app(raw, w.closed);
    const a2 = app(raw, w.blocked, { status: 'viewed' });
    const a3 = app(raw, w.closed, { status: 'rejected' });
    const wd = app(raw, w.closed, { status: 'withdrawn', purge: null, snapshot: '' });
    const pub = app(raw, w.published);
    const had = app(raw, w.closed, { purge: 123 });
    const r = await STEPS.markApplications(env, NOW);
    expect(r.done.marked).toBe(3);
    for (const a of [a1, a2, a3]) expect(appRow(raw, a).purge_after).toBe(NOW + APPLICATION_KEEP_AFTER_CLOSE);
    expect(appRow(raw, wd).purge_after).toBeNull();
    expect(appRow(raw, pub).purge_after).toBeNull();
    expect(appRow(raw, had).purge_after).toBe(123);
    expect((await STEPS.markApplications(env, NOW + 1)).done.marked).toBe(0);
  });

  it('마감 확인 후 30일: 진행 중 지원만 auto_closed 이벤트 + 상태 (1초 전후), 이벤트 없는 상태 변화 없음', async () => {
    const { raw, env } = setup();
    const w = world(raw);
    const base = NOW + APPLICATION_KEEP_AFTER_CLOSE - APPLICATION_AUTO_CLOSE_AFTER; // purge_after 가 이보다 작으면 30일이 지남
    const over = app(raw, w.closed, { purge: base - 1 });
    const over2 = app(raw, w.blocked, { purge: base - 1, status: 'interview' });
    const exact = app(raw, w.closed, { purge: base });
    const notYet = app(raw, w.closed, { purge: base + 1 });
    const rejected = app(raw, w.closed, { purge: base - 100, status: 'rejected' });
    const withdrawn = app(raw, w.closed, { purge: base - 100, status: 'withdrawn', snapshot: '' });
    const r = await STEPS.markApplications(env, NOW);
    expect(r.done).toMatchObject({ auto_closed: 2, events: 2 });
    for (const a of [over, over2]) {
      expect(appRow(raw, a)).toMatchObject({ status: 'closed', status_changed_at: NOW });
      expect(events(raw, a)).toEqual([{ event: 'auto_closed', actor_id: null, at: NOW }]);
    }
    for (const a of [exact, notYet]) { expect(appRow(raw, a).status).toBe('submitted'); expect(events(raw, a)).toEqual([]); }
    expect(appRow(raw, rejected).status).toBe('rejected');
    expect(appRow(raw, withdrawn).status).toBe('withdrawn');
    expect(num(raw, 'SELECT COUNT(*) FROM application_events')).toBe(2);
    // 두 번째 실행: 바뀌는 것 없음
    expect((await STEPS.markApplications(env, NOW)).done).toMatchObject({ auto_closed: 0, events: 0 });
    expect(num(raw, 'SELECT COUNT(*) FROM application_events')).toBe(2);
    // 1초 뒤에는 정각이던 지원도 넘는다
    expect((await STEPS.markApplications(env, NOW + 1)).done.auto_closed).toBe(1);
    expect(appRow(raw, exact).status).toBe('closed');
  });

  it('규칙 3: 이벤트 문장이 막히면 상태도 바뀌지 않는다', async () => {
    const { raw, env, cnt } = setup();
    const w = world(raw);
    const a = app(raw, w.closed, { purge: NOW });
    cnt.c.failOn = /INSERT INTO application_events/;
    await expect(STEPS.markApplications(env, NOW)).rejects.toThrow();
    expect(appRow(raw, a).status).toBe('submitted');
  });

  it('차단이 풀린 공고(초안·게재 중)의 진행 중 지원은 기한을 뗀다 — 끝난 지원·기한 지난 지원은 그대로', async () => {
    const { raw, env } = setup();
    const w = world(raw);
    const open = app(raw, w.draft, { purge: NOW + 10 * DAY });
    const open2 = app(raw, w.published, { purge: NOW + 10 * DAY, status: 'viewed' });
    const ended = app(raw, w.published, { purge: NOW + 10 * DAY, status: 'rejected' });
    const expired = app(raw, w.published, { purge: NOW });
    const wd = app(raw, w.published, { purge: NOW + 10 * DAY, status: 'withdrawn', snapshot: '' });
    const r = await STEPS.markApplications(env, NOW);
    expect(r.done).toMatchObject({ unmarked: 2, auto_closed: 0 });
    expect(appRow(raw, open).purge_after).toBeNull();
    expect(appRow(raw, open2).purge_after).toBeNull();
    expect(appRow(raw, ended).purge_after).toBe(NOW + 10 * DAY);
    expect(appRow(raw, expired).purge_after).toBe(NOW);
    expect(appRow(raw, wd).purge_after).toBe(NOW + 10 * DAY);
  });

  it('상한 50건씩', async () => {
    const { raw, env } = setup();
    const w = world(raw);
    for (let i = 0; i < 60; i++) app(raw, w.closed);
    expect((await STEPS.markApplications(env, NOW)).done.marked).toBe(50);
    expect((await STEPS.markApplications(env, NOW + 1)).done.marked).toBe(10);
    expect((await STEPS.markApplications(env, NOW + 2)).done.marked).toBe(0);
    // 자동 종료도 50건씩
    const later = NOW + APPLICATION_AUTO_CLOSE_AFTER + 10;
    expect((await STEPS.markApplications(env, later)).done.auto_closed).toBe(50);
    expect((await STEPS.markApplications(env, later + 1)).done.auto_closed).toBe(10);
    expect(num(raw, "SELECT COUNT(*) FROM application_events WHERE event = 'auto_closed'")).toBe(60);
  });
});

// ───────────────────────── 3. purgeApplications

describe.skipIf(!hasSqlite)('purgeApplications', () => {
  function world(raw: Raw) {
    const { co, members } = company(raw);
    return job(raw, co, members[0]!, { status: 'closed' });
  }
  function consent(raw: Raw, a: string) {
    const s = appRow(raw, a).seeker_id as string;
    const c = id('cs');
    raw.prepare("INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?, 'cross_border', 'v', ?, 0)").run(c, s, a);
    return c;
  }

  it('기한이 지난 지원: D1 에서 내용·파일 키·요약을 지우고(진행 중이면 auto_closed), 동의 철회, 그다음 R2 삭제 — 정각·이후는 그대로', async () => {
    const { raw, env, r2 } = setup();
    const j = world(raw);
    r2.objs.set('rfiles/a', new Date(0));
    r2.objs.set('rfiles/c', new Date(0));
    const a = app(raw, j, { purge: NOW - 1, file: 'rfiles/a', status: 'viewed' });
    const b = app(raw, j, { purge: NOW - 1, status: 'rejected' });
    const exact = app(raw, j, { purge: NOW, file: 'rfiles/c' });
    const later = app(raw, j, { purge: NOW + 1 });
    const ca = consent(raw, a), cExact = consent(raw, exact);
    // R2 를 지우는 순간에 DB 는 이미 지워져 있어야 한다
    r2.st.onDelete = (k) => {
      expect(k).toBe('rfiles/a');
      expect(appRow(raw, a)).toMatchObject({ resume_snapshot: '', file_r2_key: null, summary_zh: null });
    };
    const r = await STEPS.purgeApplications(env, NOW);
    expect(r.done).toEqual({ erased: 2, auto_closed: 1, consents: 1, files_deleted: 1, files_failed: 0 });
    expect(appRow(raw, a)).toMatchObject({ resume_snapshot: '', file_r2_key: null, summary_zh: null, status: 'closed' });
    expect(events(raw, a)).toEqual([{ event: 'auto_closed', actor_id: null, at: NOW }]);
    expect(appRow(raw, b)).toMatchObject({ resume_snapshot: '', status: 'rejected' });
    expect(events(raw, b)).toEqual([]);
    for (const x of [exact, later]) expect(appRow(raw, x).resume_snapshot).toBe('v1.cipher');
    expect(r2.objs.has('rfiles/a')).toBe(false);
    expect(r2.objs.has('rfiles/c')).toBe(true);
    expect(one(raw, 'SELECT withdrawn_at FROM consents WHERE id = ?', ca)!.withdrawn_at).toBe(NOW);
    expect(one(raw, 'SELECT withdrawn_at FROM consents WHERE id = ?', cExact)!.withdrawn_at).toBeNull();
    // 두 번째 실행: 아무것도 없음
    r2.st.onDelete = null;
    expect((await STEPS.purgeApplications(env, NOW)).done).toMatchObject({ erased: 0, files_deleted: 0 });
    expect(num(raw, 'SELECT COUNT(*) FROM application_events')).toBe(1);
  });

  it('R2 삭제가 실패해도 행은 지워진 채로 남고 실패를 센다', async () => {
    const { raw, env, r2 } = setup();
    const j = world(raw);
    r2.objs.set('rfiles/x', new Date(0));
    const a = app(raw, j, { purge: NOW - 1, file: 'rfiles/x', status: 'rejected' });
    r2.st.failDelete = true;
    const r = await STEPS.purgeApplications(env, NOW);
    expect(r.done).toMatchObject({ erased: 1, files_deleted: 0, files_failed: 1 });
    expect(appRow(raw, a)).toMatchObject({ resume_snapshot: '', file_r2_key: null });
    expect(r2.objs.has('rfiles/x')).toBe(true); // 고아 객체 → sweepOrphans
  });

  it('다른 행이 아직 같은 키를 가리키면 R2 객체를 지우지 않는다, rfiles/ 밖의 키는 지우지 않는다', async () => {
    const { raw, env, r2 } = setup();
    const j = world(raw);
    const a = app(raw, j, { purge: NOW - 1, file: 'rfiles/shared', status: 'rejected' });
    app(raw, j, { purge: NOW - 1, file: 'vdocs/company/x/y.pdf', status: 'rejected' });
    const s = appRow(raw, a).seeker_id as string;
    raw.prepare("INSERT INTO resumes (id, user_id, title, body, file_r2_key, created_at, updated_at) VALUES ('r1', ?, 't', 'b', 'rfiles/shared', 0, 0)").run(s);
    r2.objs.set('rfiles/shared', new Date(0));
    r2.objs.set('vdocs/company/x/y.pdf', new Date(0));
    const r = await STEPS.purgeApplications(env, NOW);
    expect(r.done).toMatchObject({ erased: 2, files_deleted: 0 });
    expect(r2.st.deleted).toEqual([]);
  });

  it('상한 10건씩', async () => {
    const { raw, env } = setup();
    const j = world(raw);
    for (let i = 0; i < 12; i++) app(raw, j, { purge: NOW - 1 - i });
    expect((await STEPS.purgeApplications(env, NOW)).done.erased).toBe(10);
    expect((await STEPS.purgeApplications(env, NOW)).done.erased).toBe(2);
    expect(num(raw, "SELECT COUNT(*) FROM applications WHERE resume_snapshot != ''")).toBe(0);
    expect(num(raw, "SELECT COUNT(*) FROM application_events WHERE event = 'auto_closed'")).toBe(12);
    expect(num(raw, "SELECT COUNT(*) FROM applications WHERE status = 'closed'")).toBe(12);
  });

  it('다른 지원의 동의·내용은 그대로', async () => {
    const { raw, env } = setup();
    const j = world(raw);
    const a = app(raw, j, { purge: NOW - 1 });
    const other = app(raw, j);
    const c = consent(raw, other);
    await STEPS.purgeApplications(env, NOW);
    expect(appRow(raw, a).resume_snapshot).toBe('');
    expect(appRow(raw, other).resume_snapshot).toBe('v1.cipher');
    expect(one(raw, 'SELECT withdrawn_at FROM consents WHERE id = ?', c)!.withdrawn_at).toBeNull();
  });
});

// ───────────────────────── 4. dropOldRows

describe.skipIf(!hasSqlite)('dropOldRows', () => {
  it('보관 기간이 지난 행만 지운다 (자식 먼저, 1초 전후), users·초대는 그대로', async () => {
    const { raw, env } = setup();
    const { co, members } = company(raw);
    const j = job(raw, co, members[0]!, { status: 'closed' });
    const cut = NOW - ERASED_ROW_KEEP;
    const old = app(raw, j, { purge: cut - 1, snapshot: '', status: 'withdrawn' });
    const exact = app(raw, j, { purge: cut, snapshot: '', status: 'withdrawn' });
    const notErased = app(raw, j, { purge: cut - 100 });
    for (const a of [old, exact, notErased]) raw.prepare("INSERT INTO application_events (id, application_id, event, at) VALUES (?, ?, 'withdrawn', 0)").run(id('ev'), a);
    const deletedUser = user(raw, 'seeker', 'deleted');
    const cons = (w: number | null) => { const c = id('cs'); raw.prepare("INSERT INTO consents (id, user_id, type, version, agreed_at, withdrawn_at) VALUES (?,?, 'terms', 'v', 0, ?)").run(c, deletedUser, w); return c; };
    const cOld = cons(cut - 1), cExact = cons(cut), cValid = cons(null);
    const acc = (at: number) => { const x = id('al'); raw.prepare("INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, at) VALUES (?,?, 'company', 'application', 'x', ?)").run(x, members[0]!, at); return x; };
    const alOld = acc(NOW - ACCESS_LOG_KEEP - 1), alExact = acc(NOW - ACCESS_LOG_KEEP);
    const em = (at: number) => { const x = id('em'); raw.prepare("INSERT INTO email_log (id, to_hash, template, result, sent_at) VALUES (?, 'h', 't', 'sent', ?)").run(x, at); return x; };
    const emOld = em(NOW - EMAIL_LOG_KEEP - 1), emExact = em(NOW - EMAIL_LOG_KEEP);
    raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,0,?)').run('s-old', members[0]!, NOW - 1);
    raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,0,?)').run('s-now', members[0]!, NOW);
    raw.prepare("INSERT INTO auth_codes (email, code_hash, expires_at, last_sent_at) VALUES ('old@x.test', 'h', ?, 0)").run(NOW - 1);
    raw.prepare("INSERT INTO auth_codes (email, code_hash, expires_at, last_sent_at) VALUES ('new@x.test', 'h', ?, 0)").run(NOW + 600);
    raw.prepare('INSERT INTO admin_totp_pending (id, user_id, expires_at) VALUES (?,?,?)').run('p-old', members[0]!, NOW - 1);
    raw.prepare('INSERT INTO admin_totp_pending (id, user_id, expires_at) VALUES (?,?,?)').run('p-new', members[0]!, NOW + 600);
    raw.prepare("INSERT INTO company_invites (id, company_id, email, invited_by, created_at, accepted_at) VALUES ('inv', ?, 'i@x.test', ?, 0, 0)").run(co, members[0]!);
    // 하루 사용량 (T-05c): 35일 전 날짜(한국 시간)보다 앞선 행만. NOW = 2027-01-15 17:00 KST → 기준 2026-12-11
    const cutDay = kstDay(NOW - USAGE_KEEP_DAYS * DAY);
    expect(cutDay).toBe('2026-12-11');
    for (const d of ['2026-12-10', cutDay, '2027-01-15']) raw.prepare("INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('mail_company', ?, ?, 3, 0)").run(co, d);

    const r = await STEPS.dropOldRows(env, NOW);
    expect(r.done).toEqual({ application_events: 1, applications: 1, consents: 1, access_log: 1, email_log: 1, sessions: 1, auth_codes: 1, admin_totp_pending: 1, usage_counters: 1 });
    expect(q(raw, 'SELECT day FROM usage_counters ORDER BY day').map((x) => x.day)).toEqual([cutDay, '2027-01-15']);
    const has = (tbl: string, col: string, v: string) => num(raw, `SELECT COUNT(*) FROM ${tbl} WHERE ${col} = ?`, v) === 1;
    expect(has('applications', 'id', old)).toBe(false);
    expect(has('application_events', 'application_id', old)).toBe(false);
    for (const a of [exact, notErased]) { expect(has('applications', 'id', a)).toBe(true); expect(has('application_events', 'application_id', a)).toBe(true); }
    expect([has('consents', 'id', cOld), has('consents', 'id', cExact), has('consents', 'id', cValid)]).toEqual([false, true, true]);
    expect([has('access_log', 'id', alOld), has('access_log', 'id', alExact)]).toEqual([false, true]);
    expect([has('email_log', 'id', emOld), has('email_log', 'id', emExact)]).toEqual([false, true]);
    expect([has('sessions', 'id', 's-old'), has('sessions', 'id', 's-now')]).toEqual([false, true]);
    expect([has('auth_codes', 'email', 'old@x.test'), has('auth_codes', 'email', 'new@x.test')]).toEqual([false, true]);
    expect([has('admin_totp_pending', 'id', 'p-old'), has('admin_totp_pending', 'id', 'p-new')]).toEqual([false, true]);
    expect(has('company_invites', 'id', 'inv')).toBe(true);
    expect(has('users', 'id', deletedUser)).toBe(true);
    // 두 번째 실행: 지울 것 없음
    expect(Object.values((await STEPS.dropOldRows(env, NOW)).done).every((n) => n === 0)).toBe(true);
  });

  it('표마다 200행씩', async () => {
    const { raw, env } = setup();
    const u = user(raw);
    for (let i = 0; i < 250; i++) raw.prepare("INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, at) VALUES (?,?, 'admin', 'resume', 'x', 0)").run(id('al'), u);
    expect((await STEPS.dropOldRows(env, NOW)).done.access_log).toBe(200);
    expect((await STEPS.dropOldRows(env, NOW)).done.access_log).toBe(50);
    expect(num(raw, 'SELECT COUNT(*) FROM access_log')).toBe(0);
  });

  it('하루 사용량도 표마다 200행씩 (T-05c)', async () => {
    const { raw, env } = setup();
    for (let i = 0; i < 230; i++) raw.prepare("INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('localize_company', ?, '2020-01-01', 1, 0)").run(`co-${i}`);
    raw.prepare("INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('localize_site', 'site', ?, 1, 0)").run(kstDay(NOW));
    expect((await STEPS.dropOldRows(env, NOW)).done.usage_counters).toBe(200);
    expect((await STEPS.dropOldRows(env, NOW)).done.usage_counters).toBe(30);
    expect((await STEPS.dropOldRows(env, NOW)).done.usage_counters).toBe(0);
    expect(num(raw, 'SELECT COUNT(*) FROM usage_counters')).toBe(1);
  });

  it('이벤트가 많은 지원: 이벤트를 다 지운 뒤에 지원 행을 지운다 (외래키)', async () => {
    const { raw, env } = setup();
    const { co, members } = company(raw);
    const j = job(raw, co, members[0]!, { status: 'closed' });
    const a = app(raw, j, { purge: 0, snapshot: '', status: 'withdrawn' });
    for (let i = 0; i < 205; i++) raw.prepare("INSERT INTO application_events (id, application_id, event, at) VALUES (?, ?, 'viewed', 0)").run(id('ev'), a);
    expect((await STEPS.dropOldRows(env, NOW)).done).toMatchObject({ application_events: 200, applications: 0 });
    expect((await STEPS.dropOldRows(env, NOW)).done).toMatchObject({ application_events: 5, applications: 1 });
  });
});

// ───────────────────────── 5. purgeVerificationDocs

describe.skipIf(!hasSqlite)('purgeVerificationDocs', () => {
  function doc(raw: Raw, owner: string, o: { status: string; reviewed: number | null; key?: string }): string {
    const d = id('doc');
    raw.prepare(
      "INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_at, created_at) VALUES (?, 'company', ?, 'biz_cert', ?, ?, ?, 0)",
    ).run(d, owner, o.key ?? `vdocs/company/${owner}/${d}.pdf`, o.status, o.reviewed);
    return d;
  }
  const cut = NOW - VDOC_KEEP_AFTER_REVIEW;

  it('확인 후 1년이 지난 서류: 행 먼저, 그다음 vdocs/ 객체. 확인 대기·정각·다른 접두어는 그대로', async () => {
    const { raw, env, r2 } = setup();
    const { co } = company(raw);
    const ap = doc(raw, co, { status: 'approved', reviewed: cut - 1 });
    const rj = doc(raw, co, { status: 'rejected', reviewed: cut - 1 });
    const exact = doc(raw, co, { status: 'approved', reviewed: cut });
    const pend = doc(raw, co, { status: 'pending', reviewed: 0 });
    const pendNull = doc(raw, co, { status: 'pending', reviewed: null });
    const odd = doc(raw, co, { status: 'approved', reviewed: 0, key: 'rfiles/not-a-doc' });
    for (const k of q(raw, 'SELECT r2_key FROM verification_docs')) r2.objs.set(k.r2_key as string, new Date(0));
    r2.st.onDelete = (k) => expect(num(raw, 'SELECT COUNT(*) FROM verification_docs WHERE r2_key = ?', k)).toBe(0);
    const r = await STEPS.purgeVerificationDocs(env, NOW);
    expect(r.done).toEqual({ rows_deleted: 2, files_deleted: 2, files_failed: 0 });
    const left = q(raw, 'SELECT id FROM verification_docs ORDER BY id').map((x) => x.id);
    expect(left).toEqual([exact, pend, pendNull, odd].sort());
    expect(r2.st.deleted.sort()).toEqual([`vdocs/company/${co}/${ap}.pdf`, `vdocs/company/${co}/${rj}.pdf`].sort());
    expect(r2.objs.has('rfiles/not-a-doc')).toBe(true);
    expect((await STEPS.purgeVerificationDocs(env, NOW)).done.rows_deleted).toBe(0);
  });

  it('상한 5건씩, R2 실패는 세고 행은 지워진 채', async () => {
    const { raw, env, r2 } = setup();
    const { co } = company(raw);
    for (let i = 0; i < 7; i++) doc(raw, co, { status: 'approved', reviewed: cut - 1 - i });
    r2.st.failDelete = true;
    expect((await STEPS.purgeVerificationDocs(env, NOW)).done).toEqual({ rows_deleted: 5, files_deleted: 0, files_failed: 5 });
    r2.st.failDelete = false;
    expect((await STEPS.purgeVerificationDocs(env, NOW)).done).toEqual({ rows_deleted: 2, files_deleted: 2, files_failed: 0 });
    expect(num(raw, 'SELECT COUNT(*) FROM verification_docs')).toBe(0);
  });

  it('서류가 모두 지워진 검증 완료 기업: 검증 상태·공개 그대로, 관리자 화면이 그려진다', async () => {
    const { raw, env, d1 } = setup();
    const { co } = company(raw);
    doc(raw, co, { status: 'approved', reviewed: cut - 1 });
    await STEPS.purgeVerificationDocs(env, NOW);
    const x = (await loadCompanyDetail(d1, co))!;
    expect(x.docs).toEqual([]);
    expect(x.company.verify_status).toBe('verified');
    expect(await findPublicCompany(d1, co)).not.toBeNull();
    // verifyBlocks 는 "서류 없음" 을 돌려주지만, 그 결과는 검증 대기 기업의 승인 버튼에만 쓰인다 (검증 완료 기업의 상태는 바뀌지 않는다)
    const blocks = verifyBlocks({ entity_type: x.company.entity_type, biz_no: x.company.biz_no, docTypes: [] });
    expect(blocks).toEqual(['no_document']);
    const html = String(jsx(AdminCompanyDetail, {
      locale: 'ko', company: x.company, members: x.members, docs: x.docs, blocks, snapshot: identitySnapshot(x.company),
    }));
    expect(html).toContain(`/admin/companies/${co}/revoke`); // 검증 완료 기업 화면(승인 취소 폼)
    expect(html).not.toContain('name="action" value="approve"');
  });
});

// ───────────────────────── 6. sweepOrphans

describe.skipIf(!hasSqlite)('sweepOrphans', () => {
  const at = (s: number) => new Date(s * 1000);

  it('24시간이 지났고 참조 없는 rfiles/ 객체만 지운다 (젊은 객체·참조된 객체·다른 접두어는 그대로)', async () => {
    const { raw, env, r2 } = setup();
    const { co, members } = company(raw);
    const j = job(raw, co, members[0]!);
    const s = user(raw);
    raw.prepare("INSERT INTO resumes (id, user_id, title, body, file_r2_key, created_at, updated_at) VALUES ('r1', ?, 't', 'b', 'rfiles/by-resume', 0, 0)").run(s);
    app(raw, j, { file: 'rfiles/by-app' });
    r2.objs.set('rfiles/orphan-old', at(NOW - ORPHAN_MIN_AGE - 1));
    r2.objs.set('rfiles/orphan-exact', at(NOW - ORPHAN_MIN_AGE));
    r2.objs.set('rfiles/orphan-young', at(NOW - ORPHAN_MIN_AGE + 1));
    r2.objs.set('rfiles/by-resume', at(0));
    r2.objs.set('rfiles/by-app', at(0));
    r2.objs.set('vdocs/company/c/d.pdf', at(0));
    const r = await STEPS.sweepOrphans(env, NOW);
    expect(r.done).toMatchObject({ listed: 5, young: 1, referenced: 2, deleted: 2, failed: 0, listing_done: 1 });
    expect([...r2.objs.keys()].sort()).toEqual(['rfiles/by-app', 'rfiles/by-resume', 'rfiles/orphan-young', 'vdocs/company/c/d.pdf']);
    expect((await STEPS.sweepOrphans(env, NOW)).done.deleted).toBe(0);
  });

  it('참조 확인이 실패하면 아무것도 지우지 않는다', async () => {
    const { env, r2, cnt } = setup();
    r2.objs.set('rfiles/a', at(0));
    cnt.c.failOn = /FROM resumes/;
    await expect(STEPS.sweepOrphans(env, NOW)).rejects.toThrow();
    expect(r2.objs.has('rfiles/a')).toBe(true);
    expect(r2.st.deleted).toEqual([]);
    const out = await runMaintenance(env, NOW, { force: 'sweepOrphans' });
    expect(out.ok).toBe(false);
    expect(r2.objs.has('rfiles/a')).toBe(true);
  });

  it('목록은 100개씩 커서로 이어 보고, 끝나면 커서를 지운다', async () => {
    const { raw, env, r2 } = setup();
    const { co, members } = company(raw);
    const j = job(raw, co, members[0]!);
    for (let i = 0; i < 150; i++) {
      const k = `rfiles/${String(i).padStart(3, '0')}`;
      r2.objs.set(k, at(0));
      if (i !== 120) app(raw, j, { file: k }); // 하나만 고아
    }
    const r1 = await STEPS.sweepOrphans(env, NOW);
    expect(r1.done).toMatchObject({ listed: 100, deleted: 0, cursor_moved: 1, listing_done: 0 });
    expect(one(raw, 'SELECT value FROM site_settings WHERE key = ?', ORPHAN_CURSOR_KEY)!.value).toBe('rfiles/099');
    const r2r = await STEPS.sweepOrphans(env, NOW);
    expect(r2r.done).toMatchObject({ listed: 50, deleted: 1, listing_done: 1 });
    expect(one(raw, 'SELECT value FROM site_settings WHERE key = ?', ORPHAN_CURSOR_KEY)).toBeUndefined();
    expect(r2.objs.has('rfiles/120')).toBe(false);
    expect(r2.objs.size).toBe(149);
  });

  it('지울 것이 10개를 넘으면 10개만 지우고 커서를 옮기지 않는다', async () => {
    const { raw, env, r2 } = setup();
    for (let i = 0; i < 15; i++) r2.objs.set(`rfiles/o${String(i).padStart(2, '0')}`, at(0));
    expect((await STEPS.sweepOrphans(env, NOW)).done).toMatchObject({ deleted: 10, cursor_moved: 0 });
    expect(one(raw, 'SELECT value FROM site_settings WHERE key = ?', ORPHAN_CURSOR_KEY)).toBeUndefined();
    expect((await STEPS.sweepOrphans(env, NOW)).done).toMatchObject({ deleted: 5, listing_done: 1 });
    expect(r2.objs.size).toBe(0);
  });

  it('R2 삭제 실패는 세고 커서를 옮기지 않는다, 목록 실패 때는 저장된 커서를 지운다', async () => {
    const { raw, env, r2 } = setup();
    r2.objs.set('rfiles/a', at(0));
    r2.st.failDelete = true;
    expect((await STEPS.sweepOrphans(env, NOW)).done).toMatchObject({ deleted: 0, failed: 1, cursor_moved: 0 });
    raw.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, 'rfiles/zzz', 0)").run(ORPHAN_CURSOR_KEY);
    r2.st.failList = true;
    await expect(STEPS.sweepOrphans(env, NOW)).rejects.toThrow();
    expect(one(raw, 'SELECT value FROM site_settings WHERE key = ?', ORPHAN_CURSOR_KEY)).toBeUndefined();
  });
});

// ───────────────────────── 7. report

describe.skipIf(!hasSqlite)('report', () => {
  it('OPS_EMAIL 이 없으면 메일 없이 넘어간다', async () => {
    const { env } = setup();
    expect((await STEPS.report(env, NOW)).done).toMatchObject({ mail_sent: 0, mail_skipped: 1 });
    expect(mailLogs()).toEqual([]);
  });

  it('OPS_EMAIL 로 전날 집계와 개수만 보낸다 (이메일·id 없음), 7일 지난 집계 줄을 지운다', async () => {
    const { raw, env } = setup({ ops: 'ops@example.test' });
    const { co, members } = company(raw, [{}, {}]);
    const j = job(raw, co, members[0]!);
    app(raw, j); app(raw, j, { status: 'viewed' });
    user(raw, 'seeker', 'deleted');
    const yesterday = NOW - DAY;
    raw.prepare('INSERT INTO site_settings (key, value, updated_at) VALUES (?,?,?)').run(statsKey(yesterday), JSON.stringify({ closeJobs: { runs: 5, closed_deadline: 3 }, sweepOrphans: { runs: 4, failed: 1 } }), yesterday);
    for (const d of [7, 8, 30]) raw.prepare('INSERT INTO site_settings (key, value, updated_at) VALUES (?,?,?)').run(statsKey(NOW - d * DAY), '{}', NOW - d * DAY);
    raw.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('public_job_filters', '[]', 0)").run();
    const r = await STEPS.report(env, NOW);
    expect(r.done).toEqual({ mail_sent: 1, mail_skipped: 0, old_stats_deleted: 2 });
    const mail = mailLogs().join('\n');
    expect(mail).toContain('[mail:ops_report] to=ops@example.test');
    const body = mail.slice(mail.indexOf('\n') + 1);
    expect(body).toContain('closeJobs: closed_deadline=3 runs=5');
    expect(body).toContain('sweepOrphans: failed=1 runs=4');
    expect(body).toContain('실패 1회');
    expect(body).toContain('company=2');
    expect(body).toContain('seeker=2');
    expect(body).toContain('게재 중 공고: 1');
    expect(body).toContain('submitted=1 viewed=1');
    expect(body).not.toMatch(/@|u-\d|co-\d|job-\d|app-\d/);
    const keys = q(raw, 'SELECT key FROM site_settings ORDER BY key').map((x) => x.key);
    expect(keys).toEqual(['maint.stats.2027-01-08', statsKey(yesterday), 'public_job_filters']);
    expect(num(raw, "SELECT COUNT(*) FROM email_log WHERE template = 'ops_report'")).toBe(1);
  });

  it('보고 글 모양', () => {
    const m = reportText('2027-01-14', {}, { usersByRole: {}, publishedJobs: 0, applicationsByStatus: {} });
    expect(m.subject).toBe('[Recruit] 정리 작업 보고 2027-01-14 (UTC)');
    expect(m.text).toContain('closeJobs: 실행 없음');
  });
});

// ───────────────────────── 한 번 실행의 상한 (D1 문장·R2 호출)

describe.skipIf(!hasSqlite)('한 번 실행의 D1·R2 상한', () => {
  it('후보가 상한보다 많아도 단계마다 D1 문장 25개·R2 호출 15개 이하', async () => {
    const { raw, env, r2, cnt } = setup({ ops: 'ops@example.test' });
    // 공고: 마감일 지남 15, 안내 대상 15 (기업 하나에 담당자 10명)
    const { co, members } = company(raw, Array.from({ length: 10 }, () => ({})));
    for (let i = 0; i < 15; i++) job(raw, co, members[0]!, { closes_at: NOW - 1 - i });
    for (let i = 0; i < 15; i++) job(raw, co, members[0]!, { closes_at: NOW + DAY + i });
    const other = company(raw, [{}]);
    for (let i = 0; i < 15; i++) job(raw, other.co, other.members[0]!, { updated_at: 0, notice: i % 2 ? 0 : null });
    // 지원: 모든 진행 중 상태 × 많이
    const closed = job(raw, co, members[0]!, { status: 'closed' });
    const pubJob = job(raw, co, members[0]!, { closes_at: NOW + 100 * DAY }); // 게재 중 공고: 앞 단계(markApplications)가 먼저 자동 종료하지 않게
    for (const s of AUTO_CLOSABLE) for (let i = 0; i < 20; i++) app(raw, pubJob, { status: s, purge: NOW - 1 - i, file: `rfiles/p-${s}-${i}` }); // 상태가 섞이게
    for (let i = 0; i < 80; i++) app(raw, closed);
    // 오래된 행
    for (let i = 0; i < 250; i++) raw.prepare("INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, at) VALUES (?,?, 'admin', 'resume', 'x', 0)").run(id('al'), members[0]!);
    for (let i = 0; i < 8; i++) raw.prepare("INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_at, created_at) VALUES (?, 'company', ?, 'biz_cert', ?, 'approved', 0, 0)").run(id('d'), co, `vdocs/company/${co}/${i}.pdf`);
    for (let i = 0; i < 150; i++) r2.objs.set(`rfiles/z${String(i).padStart(3, '0')}`, new Date(0));
    const seen: Record<string, { d1: number; r2: number }> = {};
    for (const s of STEP_NAMES) {
      cnt.c.n = 0;
      r2.st.ops = 0;
      const out = await runMaintenance(env, NOW, { force: s });
      expect(out.ok, s).toBe(true);
      seen[s] = { d1: cnt.c.n, r2: r2.st.ops };
      expect(cnt.c.n, `${s} D1`).toBeLessThanOrEqual(BUDGET.d1Statements);
      expect(r2.st.ops, `${s} R2`).toBeLessThanOrEqual(BUDGET.r2Ops);
    }
    expect(seen.closeJobs!.d1).toBeGreaterThan(10); // 실제로 메일을 보냈다 (email_log)
    expect(seen.purgeApplications!.d1).toBeGreaterThanOrEqual(1 + 4 * 2 + 2 + 2 + 2); // 진행 중 상태 4개가 모두 섞인 경우
    expect(seen.purgeApplications!.r2).toBe(CAPS.purgeApplications);
    expect(seen.sweepOrphans!.r2).toBe(1 + CAPS.orphanDeletes);
  });
});
