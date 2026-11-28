// 대량 테스트 데이터 (T-21: lib/bulk-seed.ts · db/bulk-seed.ts · src/bulk-seed-cli.ts). PGlite(test/pg-test-db.ts) + Map 으로 만든 가짜 파일 저장소. 모두 가짜 데이터다 (CLAUDE.md 규칙 10).
// 확인하는 것: 개수가 인자와 같다 · 다시 실행해도 늘지 않는다 · 지우기는 대량 행·파일만 지우고 시연 데이터·운영자가 만든 행은 그대로 둔다 ·
// 게재된 대량 공고는 모두 publishBlocks 를 통과한다 · 지원 상태 = 이벤트에 nextStatus 를 차례로 적용한 결과 · 🔒 컬럼과 첨부는 암호문이고 설정된 키로 풀린다 ·
// 운영(production)에서는 거절한다 · 메일 주소는 모두 받는 사람이 없는 도메인이다 · 공고 500건에서 공개 목록·필터·페이지 · 메일을 보내지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 메일 함수 감시: 대량 데이터 작업은 메일 함수를 한 번도 부르지 않아야 한다.
const mailSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/lib/email', async (orig) => {
  const m = await orig<typeof import('../src/lib/email')>();
  return { ...m, sendMail: async (...a: Parameters<typeof m.sendMail>) => { mailSpy.calls += 1; return m.sendMail(...a); } };
});

import app from '../src/index';
import { flagsOf } from '../src/env';
import {
  BULK_MAIL_DOMAIN, BULK_STAMP_KEY, DEFAULT_BULK_PARAMS, buildBulkPlan, bulkId, isBulkAddress, isBulkFileKey, isBulkId, parseBulkArgs, runBulkCommand, type BulkArgs,
} from '../src/lib/bulk-seed';
import { COMPANIES, IT_FAMILIES, REAL_BRAND_DENYLIST } from '../src/lib/bulk-content';
import { digitDiff } from '../src/lib/jobs';
import { buildOptionSet } from '../src/lib/options';
import { loadRetention } from '../src/lib/retention-setting';
import { listOptions } from '../src/db/options';
import { b64url, importEncKey } from '../src/lib/crypto';
import { isDemoAddress } from '../src/lib/demo';
import { seedDemo } from '../src/lib/demo-seed';
import { publishInputOf } from '../src/lib/jobs';
import { openResume, snapshotLang, validateResume, inputFromResume, type ResumeBody } from '../src/lib/resume';
import { decryptFile } from '../src/lib/resume-files';
import { findBannedPhrases, nextStatus, parseOperatorDomains, publishBlocks, techLeakFlag, type AppEvent, type AppStatus } from '../src/lib/rules';
import { hasDb, migratedDb } from './pg-test-db';

const ENC_KEY = b64url(new Uint8Array(32).fill(5)).replace(/-/g, '+').replace(/_/g, '/');
const ORIGIN = 'https://recruit.example.test';
const NOW = Math.floor(Date.now() / 1000);
const SMALL = { jobs: 20, companies: 5, seekers: 15, applications: 30 };

function world(over: Record<string, unknown> = {}) {
  const { raw, d1 } = migratedDb();
  const store = new Map<string, Uint8Array>();
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v : new Uint8Array(v)); },
    get: async (k: string) => (store.has(k) ? { key: k, size: store.get(k)!.length, arrayBuffer: async () => store.get(k)!.slice().buffer, body: store.get(k), httpMetadata: {} } : null),
    delete: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); },
    list: async (o: { prefix?: string; limit?: number; cursor?: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(o.prefix ?? '') && (!o.cursor || k > o.cursor)).sort();
      const page = keys.slice(0, o.limit ?? 1000);
      return { objects: page.map((key) => ({ key, size: store.get(key)!.length, uploaded: new Date() })), truncated: keys.length > page.length, cursor: page[page.length - 1] };
    },
  };
  const env = {
    APP_ENV: 'test', DEMO_LOGIN: 'on', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: 'test-pepper-0123456789', REGISTRATION_NO: '',
    MAIL_FROM: 'Recruit <no-reply@example.test>', OPERATOR_DOMAINS: 'kimbbob.xyz,kimbbob.com,nexthub.me',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off', ...over,
  } as never as import('../src/env').Env;
  const out: string[] = [];
  const run = (argv: string[], ts = NOW) => {
    const a = parseBulkArgs(argv);
    if (!a.ok) throw new Error(a.message);
    return runBulkCommand(env, a as Extract<BulkArgs, { ok: true }>, ts, (l) => out.push(l));
  };
  const n = (sql: string, ...a: unknown[]) => Number(raw.prepare(sql).get(...(a as never[]))!.n);
  const all = (sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[]));
  const req = (path: string) => app.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual' }) as never, env as never);
  return { raw, env, store, out, run, n, all, req };
}

const smallArgs = (p: Record<string, number> = SMALL) => Object.entries(p).flatMap(([k, v]) => [`--${k}`, String(v)]);
const TABLES = [
  'users', 'consents', 'companies', 'company_members', 'verification_docs', 'jobs', 'resumes', 'applications', 'application_events', 'access_log',
  'email_log', 'site_settings', 'sessions', 'alerts', 'usage_counters', 'job_options',
];
/** 표 전체를 정렬한 JSON (행 순서와 관계없이 비교). */
function dump(w: ReturnType<typeof world>): Record<string, string[]> {
  return Object.fromEntries(TABLES.map((t) => [t, w.all(`SELECT * FROM ${t}`).map((r) => JSON.stringify(r)).sort()]));
}

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  mailSpy.calls = 0;
  spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
});
afterEach(() => {
  // 콘솔에는 아무것도 쓰지 않는다 (출력은 out 함수로만)
  expect(spies.flatMap((s) => s.mock.calls).length).toBe(0);
  spies.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
});

describe('명령 인자', () => {
  it('기본값·개수·지우기·미리 보기', () => {
    expect(parseBulkArgs([])).toEqual({ ok: true, mode: 'create', dryRun: false, params: { ...DEFAULT_BULK_PARAMS } });
    expect(DEFAULT_BULK_PARAMS).toEqual({ jobs: 500, companies: 60, seekers: 300, applications: 1200 });
    expect(parseBulkArgs(['--jobs', '20', '--companies=3', '--seekers', '7', '--applications', '0'])).toEqual({
      ok: true, mode: 'create', dryRun: false, params: { jobs: 20, companies: 3, seekers: 7, applications: 0 },
    });
    expect(parseBulkArgs(['--remove'])).toMatchObject({ ok: true, mode: 'remove', dryRun: false });
    expect(parseBulkArgs(['--remove', '--dry-run'])).toMatchObject({ ok: true, mode: 'remove', dryRun: true });
    expect(parseBulkArgs(['--dry-run'])).toMatchObject({ ok: true, mode: 'create', dryRun: true });
  });
  it('잘못된 값은 거절한다', () => {
    for (const a of [['--jobs'], ['--jobs', '0'], ['--jobs', '-3'], ['--jobs', '9999999'], ['--jobs', 'abc'], ['--seekers', '1.5'], ['--x'], ['--remove', '--jobs', '3'], ['jobs']]) {
      expect(parseBulkArgs(a).ok, a.join(' ')).toBe(false);
    }
  });
  it('id·주소·파일 키 표시', () => {
    expect(bulkId(3, 7)).toBe('b5eed003-0000-4000-8000-000000000007');
    expect(bulkId(10, 1)).toBe('b5eed00a-0000-4000-8000-000000000001');
    expect(isBulkId(bulkId(1, 1))).toBe(true);
    expect(isBulkId('de300001-0000-4000-8000-000000000001')).toBe(false);
    expect(isBulkId(crypto.randomUUID())).toBe(false);
    expect(isDemoAddress(`a@${BULK_MAIL_DOMAIN}`)).toBe(true); // lib/email.ts 가 보내지 않는 주소
    expect(isBulkFileKey(`rfiles/${bulkId(9, 1)}`)).toBe(true);
    expect(isBulkFileKey(`vdocs/company/${bulkId(2, 1)}/${bulkId(6, 1)}.pdf`)).toBe(true);
    expect(isBulkFileKey(`rfiles/${crypto.randomUUID()}`)).toBe(false);
    expect(isBulkFileKey(`vdocs/company/de300002-0000-4000-8000-000000000001/x.pdf`)).toBe(false);
  });
});

describe.skipIf(!hasDb)('운영에서는 실행하지 않는다', () => {
  for (const mode of [[], ['--remove'], ['--dry-run'], ['--remove', '--dry-run']]) {
    it(`production ${mode.join(' ') || '(만들기)'}: 종료 코드 1, DB 를 읽지 않는다`, async () => {
      const w = world({ APP_ENV: 'production' });
      const db = w.env.DB;
      (w.env as { DB: unknown }).DB = new Proxy({}, { get: () => { throw new Error('DB touched'); } });
      expect(await w.run(mode)).toBe(1);
      expect(w.out.join('\n')).toContain('운영 서버');
      (w.env as { DB: unknown }).DB = db;
      expect(w.n('SELECT COUNT(*) AS n FROM users')).toBe(0);
      expect(w.store.size).toBe(0);
    });
  }
  it('알 수 없는 환경도 거절한다', async () => {
    const w = world({ APP_ENV: 'staging' });
    expect(await w.run([])).toBe(1);
    expect(w.n('SELECT COUNT(*) AS n FROM users')).toBe(0);
  });
});

describe.skipIf(!hasDb)('만들기 (작은 개수)', () => {
  it('개수가 인자와 같고, 같은 조건으로 다시 실행하면 아무것도 바뀌지 않는다', async () => {
    const w = world();
    expect(await w.run(smallArgs())).toBe(0);
    expect(w.n('SELECT COUNT(*) AS n FROM companies')).toBe(SMALL.companies);
    expect(w.n('SELECT COUNT(*) AS n FROM jobs')).toBe(SMALL.jobs);
    expect(w.n("SELECT COUNT(*) AS n FROM users WHERE role = 'seeker'")).toBe(SMALL.seekers);
    expect(w.n('SELECT COUNT(*) AS n FROM applications')).toBe(SMALL.applications);
    expect(w.n("SELECT COUNT(*) AS n FROM users WHERE role NOT IN ('seeker','company')")).toBe(0); // 관리자 없음
    expect(w.n('SELECT COUNT(*) AS n FROM company_members')).toBeGreaterThanOrEqual(SMALL.companies);
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published'")).toBeGreaterThan(0);
    expect(w.n('SELECT COUNT(*) AS n FROM resumes')).toBeGreaterThan(0);
    for (const t of ['alerts', 'sessions', 'totp_recovery_codes', 'totp_enrolments', 'admin_totp_pending', 'email_log', 'auth_codes']) {
      expect(w.n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
    expect(w.n('SELECT COUNT(*) AS n FROM users WHERE totp_secret IS NOT NULL')).toBe(0);
    // 모든 id 가 대량 표시
    for (const t of ['users', 'companies', 'jobs', 'resumes', 'applications', 'verification_docs']) {
      for (const r of w.all(`SELECT id FROM ${t}`)) expect(isBulkId(String(r.id)), `${t} ${r.id}`).toBe(true);
    }
    const before = dump(w);
    const files = [...w.store.keys()].sort();
    w.out.length = 0;
    expect(await w.run(smallArgs(), NOW + 3600)).toBe(0);
    expect(w.out.join('\n')).toContain('이미 있습니다');
    expect(dump(w)).toEqual(before);
    expect([...w.store.keys()].sort()).toEqual(files);
    expect(mailSpy.calls).toBe(0);
  });

  it('같은 조건이면 다시 만들어도 같은 행이 나온다 (결정적), 조건이 다르면 바꿔 만든다', async () => {
    const a = world(), b = world();
    await a.run(smallArgs());
    await b.run(smallArgs());
    const ids = (w: typeof a, t: string, col = 'id') => w.all(`SELECT ${col} AS v FROM ${t} ORDER BY 1`).map((r) => r.v);
    for (const t of ['users', 'companies', 'jobs', 'resumes', 'applications']) expect(ids(a, t), t).toEqual(ids(b, t));
    expect(ids(a, 'jobs', "title_zh || '|' || status")).toEqual(ids(b, 'jobs', "title_zh || '|' || status"));
    expect(ids(a, 'applications', "job_id || '|' || seeker_id || '|' || status")).toEqual(ids(b, 'applications', "job_id || '|' || seeker_id || '|' || status"));
    a.out.length = 0;
    expect(await a.run(smallArgs({ ...SMALL, jobs: 12 }))).toBe(0);
    expect(a.out.join('\n')).toContain('다시 만듭니다');
    expect(a.n('SELECT COUNT(*) AS n FROM jobs')).toBe(12);
  });

  it('중간에 끊긴 흔적(기록 없이 대량 행만 있음)이 있으면 지우고 다시 만든다', async () => {
    const w = world();
    await w.run(smallArgs());
    w.raw.prepare('DELETE FROM site_settings WHERE key = ?').run(BULK_STAMP_KEY);
    w.out.length = 0;
    expect(await w.run(smallArgs())).toBe(0);
    expect(w.out.join('\n')).toContain('끊긴');
    expect(w.n('SELECT COUNT(*) AS n FROM jobs')).toBe(SMALL.jobs);
    expect(w.n('SELECT COUNT(*) AS n FROM applications')).toBe(SMALL.applications);
  });

  it('미리 보기(--dry-run)는 아무것도 쓰지 않는다', async () => {
    const w = world();
    expect(await w.run([...smallArgs(), '--dry-run'])).toBe(0);
    expect(w.out.join('\n')).toContain('dry-run');
    for (const t of TABLES.filter((t) => t !== 'job_options')) expect(w.n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect(w.store.size).toBe(0);
    await w.run(smallArgs());
    const before = dump(w);
    expect(await w.run(['--remove', '--dry-run'])).toBe(0);
    expect(dump(w)).toEqual(before);
  });

  it('게재된 대량 공고는 모두 publishBlocks 를 통과하고, 기업 검증은 서류가 있을 때만이다', async () => {
    const w = world();
    await w.run(smallArgs({ jobs: 120, companies: 14, seekers: 20, applications: 60 }));
    const rows = w.all(`SELECT j.*, c.verify_status FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.status IN ('published','closed','blocked')`);
    expect(rows.length).toBeGreaterThan(50);
    const ctx = { flags: flagsOf(w.env), appEnv: 'test' as const, registrationNo: '', operatorDomains: parseOperatorDomains(String(w.env.OPERATOR_DOMAINS)) };
    for (const j of rows) {
      expect(publishBlocks(publishInputOf(j as never, { ...ctx, companyVerified: j.verify_status === 'verified' })), String(j.id)).toEqual([]);
      expect(j.published_at).not.toBeNull();
    }
    // 게재되지 않은 것: 초안·검토 중·기술유출 검토 대기·미검증 기업
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'draft'")).toBeGreaterThan(0);
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published' AND review_flag IS NOT NULL")).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.status != 'draft' AND c.verify_status != 'verified'")).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM companies c WHERE verify_status = 'verified' AND NOT EXISTS (SELECT 1 FROM verification_docs d WHERE d.owner_id = c.id AND d.review_status = 'approved')")).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM companies WHERE verify_status != 'verified'")).toBeGreaterThan(0);
    // 마감 공고는 지난 마감일, 공개 공고의 마감일은 미래 또는 없음
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'closed' AND (closes_at IS NULL OR closes_at > ?)", NOW)).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published' AND closes_at IS NOT NULL AND closes_at < ?", NOW)).toBe(0);
    // 모든 선택 항목 차원이 쓰였다
    for (const col of ['chinese_level', 'report_line', 'salary_basis', 'location', 'role_category']) {
      expect(w.n(`SELECT COUNT(DISTINCT ${col}) AS n FROM jobs`), col).toBeGreaterThan(1);
    }
    expect(w.n('SELECT COUNT(*) AS n FROM jobs WHERE salary_min IS NULL')).toBeGreaterThan(0);
    expect(w.n('SELECT COUNT(DISTINCT entry_stage) AS n FROM companies')).toBeGreaterThan(1);
    // 기업·구직자 이름에는 가상 표시
    for (const c of w.all('SELECT name_ko, name_zh FROM companies')) { expect(String(c.name_ko)).toContain('(가상)'); expect(String(c.name_zh)).toContain('（虚拟）'); }
  });

  it('지원 상태 = 이벤트에 nextStatus 를 차례로 적용한 결과, 열람 이벤트마다 열람 기록, 국외 이전 동의 경로', async () => {
    const w = world();
    await w.run(smallArgs({ jobs: 60, companies: 12, seekers: 40, applications: 150 }));
    const apps = w.all('SELECT id, status, status_changed_at, created_at, cross_border_consent_at, resume_snapshot, file_r2_key FROM applications');
    expect(apps.length).toBe(150);
    const evs = w.all('SELECT application_id, event, at FROM application_events ORDER BY at, id');
    const byApp = new Map<string, Array<{ event: string; at: number }>>();
    for (const e of evs) { const k = String(e.application_id); if (!byApp.has(k)) byApp.set(k, []); byApp.get(k)!.push({ event: String(e.event), at: Number(e.at) }); }
    const seen = new Set<string>();
    for (const a of apps) {
      let s: AppStatus = 'submitted';
      for (const e of byApp.get(String(a.id)) ?? []) s = nextStatus(s, e.event as AppEvent);
      expect(a.status, String(a.id)).toBe(s);
      seen.add(s);
      if (s === 'withdrawn') { expect(a.resume_snapshot).toBe(''); expect(a.file_r2_key).toBeNull(); }
    }
    for (const s of ['submitted', 'viewed', 'interview', 'rejected']) expect(seen.has(s), s).toBe(true);
    expect(w.n("SELECT COUNT(*) AS n FROM application_events WHERE event = 'viewed'")).toBe(w.n("SELECT COUNT(*) AS n FROM access_log WHERE target_type = 'application'"));
    // 열람한 사람은 그 기업의 담당자이고, 본사 소속이면 국외 이전 동의가 있는 지원만
    expect(w.n(`SELECT COUNT(*) AS n FROM application_events e JOIN applications a ON a.id = e.application_id JOIN jobs j ON j.id = a.job_id
      WHERE e.event != 'withdrawn' AND NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = j.company_id AND m.user_id = e.actor_id
        AND (m.is_hq = 0 OR a.cross_border_consent_at IS NOT NULL))`)).toBe(0);
    // 국외 이전 동의: 동의 시각이 있는 지원마다 consents 한 줄, 본사 담당자가 없는 기업의 지원에는 동의가 없다
    expect(w.n("SELECT COUNT(*) AS n FROM applications WHERE cross_border_consent_at IS NOT NULL")).toBeGreaterThan(0);
    expect(w.n("SELECT COUNT(*) AS n FROM consents WHERE type = 'cross_border'")).toBe(w.n('SELECT COUNT(*) AS n FROM applications WHERE cross_border_consent_at IS NOT NULL'));
    expect(w.n(`SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.cross_border_consent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = j.company_id AND m.is_hq = 1)`)).toBe(0);
    // 지원한 공고는 지원할 때 공개 중이었다 (초안·미검증 기업 공고에는 지원 없음), 인기 공고와 지원 없는 공고가 함께 있다
    expect(w.n("SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.status = 'draft'")).toBe(0);
    const perJob = w.all("SELECT j.id, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS n FROM jobs j WHERE j.status = 'published'").map((r) => Number(r.n));
    expect(Math.max(...perJob)).toBeGreaterThan(5);
    expect(perJob.filter((x) => x === 0).length).toBeGreaterThan(0);
    // 필수 동의는 지금 판
    expect(w.n("SELECT COUNT(*) AS n FROM consents WHERE type IN ('terms','privacy')")).toBe(2 * w.n('SELECT COUNT(*) AS n FROM users'));
  });

  it('🔒 컬럼과 첨부는 암호문이고 설정된 키로 풀린다, 메일 주소는 모두 받는 사람이 없는 도메인이다', async () => {
    const w = world();
    await w.run(smallArgs({ jobs: 30, companies: 6, seekers: 30, applications: 40 }));
    const key = await importEncKey(ENC_KEY);
    const resumes = w.all('SELECT id, title, body, file_r2_key FROM resumes');
    expect(resumes.some((r) => r.file_r2_key)).toBe(true);
    for (const r of resumes) {
      expect(String(r.body).startsWith('v1.')).toBe(true);
      expect(String(r.body)).not.toContain('(가상)');
      const b = await openResume(key, String(r.body));
      expect(b.name).toContain('(가상)');
      expect(isBulkAddress(b.contact_email)).toBe(true);
      if (b.phone) expect(b.phone).toMatch(/^010-0000-\d{4}$/);
      expect(validateResume(inputFromResume(String(r.title), b)).ok).toBe(true);
      expect(!!b.file).toBe(!!r.file_r2_key);
      if (r.file_r2_key) {
        const stored = w.store.get(String(r.file_r2_key))!;
        expect(new TextDecoder().decode(stored.slice(0, 3))).toBe('RF1');
        expect(new TextDecoder().decode(stored)).not.toContain('SAMPLE RESUME');
        const plain = await decryptFile(key, stored, String(r.file_r2_key));
        expect(new TextDecoder().decode(plain.slice(0, 5))).toBe('%PDF-');
        expect(plain.length).toBe(b.file!.size);
        await expect(decryptFile(await importEncKey(b64url(new Uint8Array(32).fill(6)).replace(/-/g, '+').replace(/_/g, '/')), stored, String(r.file_r2_key))).rejects.toThrow();
      }
    }
    for (const a of w.all("SELECT resume_snapshot, file_r2_key, resume_lang FROM applications WHERE status != 'withdrawn'")) {
      expect(String(a.resume_snapshot).startsWith('v1.')).toBe(true);
      const b = await openResume(key, String(a.resume_snapshot));
      expect(snapshotLang(b)).toBe(a.resume_lang); // T-22: 복사본의 작성 언어 = 지원 행의 표시용 컬럼
      expect(!!b.file).toBe(!!a.file_r2_key);
      if (a.file_r2_key) expect(new TextDecoder().decode(await decryptFile(key, w.store.get(String(a.file_r2_key))!, String(a.file_r2_key))).slice(0, 5)).toBe('%PDF-');
    }
    // 메일 주소: 로그인·공고 연락처 모두 bulk.demo.example
    for (const r of w.all('SELECT email FROM users')) expect(isBulkAddress(String(r.email)), String(r.email)).toBe(true);
    for (const r of w.all('SELECT contact_email FROM jobs')) expect(isBulkAddress(String(r.contact_email))).toBe(true);
    // 파일은 모두 대량 키 모양
    for (const k of w.store.keys()) expect(isBulkFileKey(k), k).toBe(true);
    // 출력에는 개수뿐 (주소·이름 없음)
    const text = w.out.join('\n');
    expect(text).not.toContain('@');
    expect(text).not.toContain('(가상)');
    expect(text).not.toContain('v1.');
    expect(mailSpy.calls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasDb)('지우기', () => {
  it('대량 행·파일만 지우고, 시연 데이터와 운영자가 만든 행은 그대로 둔다', async () => {
    const w = world();
    expect(await seedDemo(w.env)).toBe(true);
    // 운영자가 손으로 만든 행 (가짜)
    w.raw.prepare("INSERT INTO users (id, email, role, locale, status, created_at) VALUES (?, ?, 'admin', 'ko', 'active', 1)").run('11111111-1111-4111-8111-111111111111', 'op@example.test');
    w.raw.prepare("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES (?, '운영자 시험 기업', 'cn_hq', 'pending', 1)").run('22222222-2222-4222-8222-222222222222');
    w.raw.prepare("INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('public_job_filters', '[\"location\"]', NULL, 1)").run();
    await w.env.FILES.put('rfiles/33333333-3333-4333-8333-333333333333', new Uint8Array([1, 2, 3]));
    const before = dump(w);
    const filesBefore = [...w.store.keys()].sort();

    await w.run(smallArgs());
    expect(w.n('SELECT COUNT(*) AS n FROM jobs')).toBeGreaterThan(SMALL.jobs);
    // 대량 행이 시연 행을 바꾸지 않았다
    const mid = dump(w);
    for (const t of TABLES.filter((t) => t !== 'site_settings')) for (const row of before[t]!) expect(mid[t], t).toContain(row);
    // 다른 회원(시연 구직자)이 대량 공고에 낸 지원 → 공고와 함께 지워지고 개수를 알린다
    const job = String(w.all("SELECT id FROM jobs WHERE id LIKE 'b5eed003%' AND status = 'published' AND (closes_at IS NULL OR closes_at > ?) LIMIT 1", NOW)[0]!.id);
    w.raw.prepare("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status, status_changed_at, created_at) VALUES (?, ?, 'de300001-0000-4000-8000-000000000002', 'v1.x', 'submitted', 1, 1)")
      .run('44444444-4444-4444-8444-444444444444', job);

    w.out.length = 0;
    expect(await w.run(['--remove', '--dry-run'])).toBe(0);
    expect(w.out.join('\n')).toContain('다른 회원이 낸 지원 1건');
    w.out.length = 0;
    expect(await w.run(['--remove'])).toBe(0);
    expect(w.out.join('\n')).toContain('다른 회원이 낸 지원 1건도 함께 지웠습니다');
    expect(dump(w)).toEqual(before);
    expect([...w.store.keys()].sort()).toEqual(filesBefore);
    // 두 번째 지우기는 할 일이 없다
    w.out.length = 0;
    expect(await w.run(['--remove'])).toBe(0);
    expect(w.out.join('\n')).toContain('지울 대량 테스트 데이터가 없습니다');
    expect(dump(w)).toEqual(before);
  });

  it('행이 가리키지 않는 대량 파일(끊긴 실행의 흔적)과 앱이 나중에 붙인 행(세션·메일 기록·사용량)도 지운다', async () => {
    const w = world();
    await w.run(smallArgs());
    await w.env.FILES.put(`rfiles/${bulkId(9, 999)}`, new Uint8Array([9]));
    const user = String(w.all("SELECT id FROM users WHERE role = 'company' LIMIT 1")[0]!.id);
    const company = String(w.all('SELECT id FROM companies LIMIT 1')[0]!.id);
    w.raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 1, 2)').run('s1', user);
    w.raw.prepare("INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('mail', ?, '2026-11-28', 1, 1)").run(company);
    const { sha256Hex } = await import('../src/lib/crypto');
    const email = String(w.all('SELECT email FROM users WHERE id = ?', user)[0]!.email);
    w.raw.prepare("INSERT INTO email_log (id, to_hash, template, result, sent_at) VALUES ('m1', ?, 'job_close_notice', 'demo_address', 1)").run(await sha256Hex(email));
    w.raw.prepare("INSERT INTO email_log (id, to_hash, template, result, sent_at) VALUES ('m2', 'other', 'auth_code', 'sent', 1)").run();
    expect(await w.run(['--remove'])).toBe(0);
    for (const t of TABLES.filter((t) => t !== 'job_options' && t !== 'email_log')) expect(w.n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect(w.all('SELECT id FROM email_log').map((r) => r.id)).toEqual(['m2']);
    expect(w.store.size).toBe(0);
  });
});

describe.skipIf(!hasDb)('공고 500건의 공개 목록', () => {
  it('첫 페이지·마지막 페이지·필터 한 개가 빠르게 그려진다', async () => {
    const w = world();
    const t0 = performance.now();
    expect(await w.run(smallArgs({ jobs: 500, companies: 30, seekers: 10, applications: 20 }))).toBe(0);
    const seedMs = performance.now() - t0;
    const visible = w.n("SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.status = 'published' AND c.verify_status = 'verified' AND (j.closes_at IS NULL OR j.closes_at > ?)", NOW);
    expect(w.n('SELECT COUNT(*) AS n FROM jobs')).toBe(500);
    expect(visible).toBeGreaterThan(300);
    // T-22 운영자 요청: 공고의 절반 넘게 IT 직무 (role_category = 'it')
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE role_category = 'it'")).toBeGreaterThan(250);
    const lastPage = Math.ceil(visible / 20);
    const rowsOf = (html: string) => (html.match(/href="\/jobs\/b5eed003-[0-9a-f-]{27}"/g) ?? []).length;

    const t1 = performance.now();
    const p1 = await w.req('/jobs');
    expect(p1.status).toBe(200);
    const h1 = await p1.text();
    expect(rowsOf(h1)).toBe(20);
    expect(h1).toContain('page=2');

    const pl = await w.req(`/jobs?page=${lastPage}`);
    expect(pl.status).toBe(200);
    const hl = await pl.text();
    expect(rowsOf(hl)).toBe(visible - (lastPage - 1) * 20);
    expect(hl).not.toContain(`page=${lastPage + 1}`);
    expect(rowsOf(await (await w.req(`/jobs?page=${lastPage + 1}`)).text())).toBe(0);

    const seoul = w.n("SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.status = 'published' AND c.verify_status = 'verified' AND j.location = 'seoul' AND (j.closes_at IS NULL OR j.closes_at > ?)", NOW);
    let fr = await w.req('/jobs?location=seoul');
    if (fr.status === 302) fr = await w.req(fr.headers.get('location')!);
    expect(fr.status).toBe(200);
    expect(rowsOf(await fr.text())).toBe(Math.min(20, seoul));

    // 상세 하나
    const id = String(w.all("SELECT id FROM jobs WHERE status = 'published' AND (closes_at IS NULL OR closes_at > ?) LIMIT 1", NOW)[0]!.id);
    expect((await w.req(`/jobs/${id}`)).status).toBe(200);
    const renderMs = performance.now() - t1;
    expect(renderMs).toBeLessThan(10_000);
    expect(seedMs).toBeLessThan(120_000);
    expect(mailSpy.calls).toBe(0);
  }, 180_000);
});

// ── T-22 시나리오형 내용: 기본 개수로 계획만 만들어(DB 에 넣지 않음) 글과 비율을 본다.

/** 공고에 쓰면 안 되는 차별 요건 (나이·성별·혼인·용모·출신지 — 채용절차법·남녀고용평등법·고령자고용법). 본보기로 써도 안 된다. */
const DISCRIMINATORY: readonly RegExp[] = [
  /나이/, /연령/, /\d+\s*세\s*(이하|미만|이상|까지)/, /만\s*\d+\s*세/, /남성/, /여성/, /남자/, /여자/, /성별/, /용모/, /외모/, /미혼/, /기혼/, /결혼/,
  /출신\s*지역/, /고향/, /군필/, /병역/, /키\s*\d/, /신체/,
  /年龄/, /岁/, /男/, /女/, /性别/, /婚/, /形象/, /五官/, /身高/, /籍贯/, /户口/, /相貌/, /长相/,
];
const EMOJI = /\p{Extended_Pictographic}/u;
const HANGUL = /[가-힣]/;
const IT_DESIRED = new Set(IT_FAMILIES.flatMap((f) => [...f.resume.desired]));

describe.skipIf(!hasDb)('T-22 시나리오형 내용 (기본 개수의 계획)', async () => {
  const w = world();
  const key = await importEncKey(ENC_KEY);
  const plan = await buildBulkPlan({ ...DEFAULT_BULK_PARAMS }, {
    now: NOW, encKey: key, flags: flagsOf(w.env), appEnv: 'test', registrationNo: '', operatorDomains: parseOperatorDomains(String(w.env.OPERATOR_DOMAINS)),
    retention: await loadRetention(w.env.DB), options: buildOptionSet(await listOptions(w.env.DB)),
  });
  const bodies = new Map<string, ResumeBody>();
  for (const r of plan.resumes) bodies.set(r.id, await openResume(key, r.body));
  const jobText = plan.jobs.map((j) => [j.row.title_zh, j.row.source_zh, j.row.title_ko ?? '', j.row.body_ko ?? ''].join('\n'));
  const companyText = plan.base.companies.map((c) => [c.name_ko, c.name_zh, c.hq_name, c.profile_ko].join('\n'));
  const resumeText = plan.resumes.map((r) => { const b = bodies.get(r.id)!; return [r.title, b.headline, b.desired_role ?? '', b.experience_text ?? '', b.file?.name ?? ''].join('\n'); });
  const allText = [...jobText, ...companyText, ...resumeText];

  it('IT 직무가 공고의 절반을 넘고(운영자 요청), IT 공고는 여러 업계에 퍼져 있다', () => {
    const it = plan.jobs.filter((j) => j.row.role_category === 'it');
    expect(it.length / plan.jobs.length).toBeGreaterThan(0.5);
    expect(it.length / plan.jobs.length).toBeLessThan(0.75);
    expect(new Set(it.map((j) => j.row.industry)).size).toBeGreaterThanOrEqual(6);
    // 주니어·시니어·리드가 섞여 있다
    for (const lv of ['初级', '高级', '团队负责人']) expect(it.some((j) => j.row.title_zh.includes(lv)), lv).toBe(true);
    expect(new Set(plan.jobs.map((j) => j.row.role_category)).size).toBeGreaterThanOrEqual(10);
  });

  it('구직자의 절반 이상이 IT 경력이고, IT 공고 지원자도 대부분 IT 경력자다', () => {
    const firstOf = new Map<string, ResumeBody>();
    for (const r of plan.resumes) if (r.is_default === 1) firstOf.set(r.user_id, bodies.get(r.id)!);
    const itSeekers = [...firstOf.values()].filter((b) => IT_DESIRED.has(b.desired_role ?? '')).length;
    expect(itSeekers / firstOf.size).toBeGreaterThanOrEqual(0.5);
    const itJobs = new Set(plan.jobs.filter((j) => j.row.role_category === 'it').map((j) => j.row.id));
    const toIt = plan.applications.filter((a) => itJobs.has(a.jobId));
    expect(toIt.filter((a) => IT_DESIRED.has(bodies.get(a.resumeId)!.desired_role ?? '')).length / toIt.length).toBeGreaterThan(0.6);
  });

  it('중국어 이력서가 약 30%, 두 언어 이력서를 모두 가진 구직자가 있다 (한국어가 대표, 중국어는 "중국어 이력서")', () => {
    const zh = plan.resumes.filter((r) => r.lang === 'zh');
    expect(zh.length / plan.resumes.length).toBeGreaterThan(0.24);
    expect(zh.length / plan.resumes.length).toBeLessThan(0.36);
    const byUser = new Map<string, typeof plan.resumes>();
    for (const r of plan.resumes) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    const both = [...byUser.values()].filter((rs) => rs.length === 2);
    expect(both.length / DEFAULT_BULK_PARAMS.seekers).toBeGreaterThan(0.1);
    expect(byUser.size).toBeGreaterThan(220);
    for (const rs of both) {
      expect(rs.map((r) => `${r.lang}:${r.is_default}`)).toEqual(['ko:1', 'zh:0']);
      expect(rs[1]!.title).toBe('중국어 이력서');
      expect(bodies.get(rs[0]!.id)!.name).toBe(bodies.get(rs[1]!.id)!.name);
    }
    for (const rs of byUser.values()) expect(rs.filter((r) => r.is_default === 1).length).toBe(1);
    // 중국어 이력서는 중국어로, 한국어 이력서는 한국어로 쓰여 있다
    for (const r of zh) {
      const b = bodies.get(r.id)!;
      expect(HANGUL.test(`${b.headline}${b.desired_role}${b.experience_text ?? ''}`.replace(b.name, '')), r.id).toBe(false);
      expect(['business', 'native']).toContain(b.chinese_level);
    }
    for (const r of plan.resumes.filter((x) => x.lang === 'ko')) expect(HANGUL.test(bodies.get(r.id)!.headline)).toBe(true);
  });

  it('지원: 두 언어 이력서가 있으면 중국어 수준이 높은 공고에 중국어 이력서를 더 자주 낸다, 지원 언어 = 고른 이력서의 언어', () => {
    const owners = new Map<string, number>();
    for (const r of plan.resumes) owners.set(r.user_id, (owners.get(r.user_id) ?? 0) + 1);
    const cnOf = new Map(plan.jobs.map((j) => [j.row.id, j.row.chinese_level]));
    const rate = (levels: string[]) => {
      const xs = plan.applications.filter((a) => owners.get(a.seekerId) === 2 && levels.includes(cnOf.get(a.jobId)!));
      return xs.filter((a) => a.resumeLang === 'zh').length / Math.max(1, xs.length);
    };
    expect(rate(['business', 'native'])).toBeGreaterThan(rate(['none', 'basic']) + 0.2);
    const langOf = new Map(plan.resumes.map((r) => [r.id, r.lang]));
    for (const a of plan.applications) expect(a.resumeLang).toBe(langOf.get(a.resumeId));
    expect(plan.applications.filter((a) => a.resumeLang === 'zh').length).toBeGreaterThan(100);
  });

  it('기업: 60곳 모두 가상 표시로 끝나고, 실제 브랜드 이름이 들어 있지 않으며, 업계·진출 단계가 고루 있다', () => {
    expect(plan.base.companies.length).toBe(60);
    expect(new Set(plan.base.companies.map((c) => c.name_zh)).size).toBe(60);
    for (const c of plan.base.companies) {
      expect(c.name_ko.endsWith('(가상)'), c.name_ko).toBe(true);
      expect(c.name_zh.endsWith('（虚拟）'), c.name_zh).toBe(true);
      expect(c.hq_name.endsWith('（虚拟）')).toBe(true);
      for (const b of REAL_BRAND_DENYLIST) {
        for (const n of [c.name_ko, c.name_zh, c.hq_name]) expect(n.toLowerCase().includes(b.toLowerCase()), `${n} ~ ${b}`).toBe(false);
      }
      expect(c.profile_ko).toContain('【公司简介】');
    }
    expect(new Set(COMPANIES.map((c) => c.sector)).size).toBe(13);
    expect(new Set(plan.base.companies.map((c) => c.entry_stage))).toEqual(new Set(['preparing', 'just_established', 'operating']));
    expect(plan.base.companies.filter((c) => c.entity_type === 'cn_hq').every((c) => c.entry_stage === 'preparing')).toBe(true);
  });

  it('모든 글에 금지 표현·차별 요건·이모지가 없다', () => {
    for (const t of allText) {
      expect(findBannedPhrases(t), t.slice(0, 40)).toEqual([]);
      for (const re of DISCRIMINATORY) expect(re.test(t), `${re} — ${t.slice(0, 60)}`).toBe(false);
      expect(EMOJI.test(t), t.slice(0, 40)).toBe(false);
    }
  });

  it('공고 글: 중국어 원문은 중국어, 숫자는 한국어와 같고, 연봉은 본문에 없고, 기술유출 필터에는 예시 공고만 걸린다', () => {
    for (const j of plan.jobs) {
      expect(HANGUL.test(`${j.row.title_zh}\n${j.row.source_zh}`), j.row.title_zh).toBe(false);
      expect(j.row.source_zh).toContain('【岗位职责】');
      expect(j.row.source_zh).toContain('【任职要求】');
      if (j.row.body_ko) {
        expect(j.row.body_ko).toContain('[담당 업무]');
        expect(digitDiff(`${j.row.title_zh}\n${j.row.source_zh}`, `${j.row.title_ko}\n${j.row.body_ko}`), j.row.title_zh).toEqual({ missing: [], extra: [] });
      }
      for (const t of [j.row.source_zh, j.row.body_ko ?? '']) expect(/\d\s*(万|元|만\s*원|천\s*원)|年薪|月薪|面议|연봉|월급|급여 협의/.test(t), j.row.title_zh).toBe(false);
      const flagged = techLeakFlag(jobText[plan.jobs.indexOf(j)]!) !== null;
      expect(flagged, j.row.title_zh).toBe(j.want === 'tech');
    }
    expect(plan.jobs.some((j) => j.want === 'tech')).toBe(true); // 관리자 검토 대기 예시가 남아 있다
    // 짧은 공고와 자세한 공고가 섞여 있다
    const sizes = plan.jobs.map((j) => j.row.source_zh.length);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes) * 2.5);
    expect(plan.jobs.some((j) => j.row.source_zh.includes('五险一金'))).toBe(true);
    expect(plan.jobs.filter((j) => j.row.body_ko?.includes('五险一金')).every((j) => j.row.body_ko!.includes('五险一金(중국의 사회보험·주택공적금)'))).toBe(true);
  });
});
