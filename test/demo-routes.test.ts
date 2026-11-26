// 시연 계정 로그인과 시연 데이터 넣기·되돌리기 — app.fetch 로 라우트 전체를 돈다 (lib/demo.ts · lib/demo-seed.ts · db/demo.ts · routes/auth.tsx).
// SQLite 메모리 DB(test/sqlite-d1.ts) + Map 으로 만든 가짜 R2. 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
//
// 가장 중요한 확인: 운영(production)에서는 DEMO_LOGIN 을 켜도 시연 로그인 주소가 없고 데이터도 들어가지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { configChecks } from '../src/lib/config-check';
import { b64url } from '../src/lib/crypto';
import { DEMO_ACCOUNTS, DEMO_RESET_AFTER, DEMO_STAMP_KEY, demoId, parseDemoStamp } from '../src/lib/demo';
import { DEMO_APPLICATIONS, DEMO_COMPANIES, DEMO_JOBS, DEMO_RESUMES, DEMO_USERS } from '../src/lib/demo-data';
import { seedDemo } from '../src/lib/demo-seed';
import { sendMail } from '../src/lib/email';
import { configIssues } from '../scripts/lib/deploy-checks.mjs';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(9)).replace(/-/g, '+').replace(/_/g, '/');
const ORIGIN = 'https://recruit.example.test';
const U = (n: number) => demoId(1, n), C = (n: number) => demoId(2, n), J = (n: number) => demoId(3, n), R = (n: number) => demoId(4, n), A = (n: number) => demoId(5, n);

function world(over: Record<string, unknown> = {}) {
  const { raw, d1 } = migratedDb();
  const store = new Map<string, Uint8Array>();
  const FILES = {
    put: async (k: string, v: Uint8Array) => { store.set(k, v); },
    get: async (k: string) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.buffer, body: store.get(k), httpMetadata: {} } : null),
    delete: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); },
  };
  const env = {
    APP_ENV: 'test', DEMO_LOGIN: 'on', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: 'test-pepper-0123456789', REGISTRATION_NO: '',
    MAIL_FROM: 'Recruit <no-reply@example.test>', OPERATOR_DOMAINS: 'kimbbob.xyz,kimbbob.com,nexthub.me',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off', ...over,
  } as never;
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { ...init, redirect: 'manual', headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } }) as never, env);
  const post = (path: string, form: Record<string, string>, o: { cookie?: string; origin?: string | null } = {}) =>
    req(path, {
      method: 'POST', body: new URLSearchParams(form), cookie: o.cookie,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }) },
    });
  /** 시연 계정으로 로그인하고 쿠키 문자열을 돌려준다. */
  const login = async (account: string): Promise<string> => {
    const res = await post('/login/demo', { account });
    expect(res.status, `login ${account}`).toBe(302);
    expect(res.headers.get('location')).toBe('/my');
    const m = /(?:^|,\s*)sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
    expect(m, 'sid cookie').not.toBeNull();
    return `sid=${m![1]}; lang=ko`;
  };
  const n = (sql: string, ...a: unknown[]) => Number(raw.prepare(sql).get(...(a as never[]))!.n);
  const one = (sql: string, ...a: unknown[]) => { const r = raw.prepare(sql).get(...(a as never[])); return r ? { ...r } : undefined; };
  const ageStamp = () => raw.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(JSON.stringify({ v: 1, at: 1000 }), DEMO_STAMP_KEY);
  return { raw, env, store, req, post, login, n, one, ageStamp };
}

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})); });
afterEach(() => {
  // 콘솔에 시연 계정의 주소·이름·암호문이 나오지 않는다
  const out = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
  for (const s of ['demo.example', '(시연)', 'v1.']) expect(out).not.toContain(s);
  spies.forEach((s) => s.mockRestore());
  vi.unstubAllGlobals();
});

describe.skipIf(!hasSqlite)('운영 서버에서는 시연 로그인이 없다', () => {
  for (const over of [{ APP_ENV: 'production' }, { APP_ENV: 'production', DEMO_LOGIN: 'on' }, { DEMO_LOGIN: 'off' }, { DEMO_LOGIN: undefined }, { APP_ENV: 'staging' }]) {
    it(`${JSON.stringify(over)}: 로그인 화면에 시연 계정 칸이 없고, POST /login/demo 는 404 이며, 아무 데이터도 생기지 않는다`, async () => {
      const w = world(over);
      const html = await (await w.req('/login')).text();
      expect(html).not.toContain('/login/demo');
      for (const a of DEMO_ACCOUNTS) {
        const res = await w.post('/login/demo', { account: a.key });
        expect(res.status).toBe(404);
        expect(res.headers.get('set-cookie') ?? '').not.toContain('sid=');
      }
      expect(await seedDemo(w.env)).toBe(false);
      for (const t of ['users', 'sessions', 'companies', 'jobs', 'resumes', 'applications', 'consents']) expect(w.n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
      expect(w.one('SELECT value FROM site_settings WHERE key = ?', DEMO_STAMP_KEY)).toBeUndefined();
      expect(w.store.size).toBe(0);
    });
  }
});

describe.skipIf(!hasSqlite)('시연 로그인 (테스트 서버)', () => {
  it('로그인 화면에 시연 계정이 모두 보이고, 처음 로그인할 때 시연 데이터가 들어간다', async () => {
    const w = world();
    const html = await (await w.req('/login')).text();
    expect(html).toContain('action="/login/demo"');
    for (const a of DEMO_ACCOUNTS) expect(html).toContain(`value="${a.key}"`);
    expect(w.n('SELECT COUNT(*) AS n FROM users')).toBe(0); // 화면을 여는 것만으로는 넣지 않는다

    await w.login('seeker');
    expect(w.n('SELECT COUNT(*) AS n FROM users')).toBe(DEMO_USERS.length);
    expect(w.n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).toBe(0);
    expect(w.n('SELECT COUNT(*) AS n FROM companies')).toBe(DEMO_COMPANIES.length);
    expect(w.n('SELECT COUNT(*) AS n FROM jobs')).toBe(DEMO_JOBS.length);
    expect(w.n('SELECT COUNT(*) AS n FROM resumes')).toBe(DEMO_RESUMES.length);
    expect(w.n('SELECT COUNT(*) AS n FROM applications')).toBe(DEMO_APPLICATIONS.length);
    expect(w.n("SELECT COUNT(*) AS n FROM consents WHERE type IN ('terms','privacy')")).toBe(DEMO_USERS.length * 2);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE mfa != 0')).toBe(0);
    expect(parseDemoStamp(String(w.one('SELECT value FROM site_settings WHERE key = ?', DEMO_STAMP_KEY)!.value))).not.toBeNull();
    // 이력서·지원서는 암호문으로만 저장된다
    expect(w.n("SELECT COUNT(*) AS n FROM resumes WHERE body NOT LIKE 'v1.%'")).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM applications WHERE resume_snapshot NOT LIKE 'v1.%'")).toBe(0);
    // 예시 서류 파일
    expect(w.store.size).toBe(DEMO_COMPANIES.filter((c) => c.wantVerified).length);
  });

  it('목록 밖의 이름·관리자·빈 값으로는 들어올 수 없다', async () => {
    const w = world();
    for (const account of ['', 'admin', 'nobody', U(1), 'seeker.kim@demo.example']) {
      const res = await w.post('/login/demo', { account });
      expect(res.status, account).toBe(400);
      expect(res.headers.get('set-cookie') ?? '').not.toContain('sid=');
    }
    expect(w.n('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  it('다른 사이트에서 보낸 요청은 받지 않는다 (출처 검사)', async () => {
    const w = world();
    expect((await w.post('/login/demo', { account: 'seeker' }, { origin: 'https://evil.example.test' })).status).toBe(403);
    expect((await w.post('/login/demo', { account: 'seeker' }, { origin: null })).status).toBe(403);
    expect(w.n('SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('구직자: 지원 현황과 이력서가 보인다', async () => {
    const w = world();
    const cookie = await w.login('seeker');
    const apps = await w.req('/my/applications', { cookie });
    expect(apps.status).toBe(200);
    const html = await apps.text();
    for (const t of ['한국 시장 영업 매니저', '고객 성공 매니저', '한국 법인 설립 준비 운영 매니저', '이커머스 운영 MD']) expect(html).toContain(t);
    const resumes = await (await w.req('/my/resumes', { cookie })).text();
    expect(resumes).toContain('영업·사업개발용');
    expect((await w.req(`/my/applications/${A(1)}`, { cookie })).status).toBe(200);
    // 다른 시연 구직자의 지원서는 열 수 없다
    expect((await w.req(`/my/applications/${A(5)}`, { cookie })).status).toBe(404);
    expect((await w.req('/admin', { cookie })).status).toBe(403);
    expect((await w.req('/biz', { cookie })).status).toBe(403);
  });

  it('공개 목록: 게재 조건을 만족한 공고만 보이고, 검토 대기·초안·마감 공고는 보이지 않는다', async () => {
    const w = world();
    await w.login('seeker_new');
    expect(w.n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published'")).toBe(14);
    const list = await (await w.req('/jobs')).text();
    expect(list).toContain('한국 시장 영업 매니저');
    expect(list).not.toContain('디스플레이 구동 회로설계');
    expect((await w.req(`/jobs/${J(1)}`)).status).toBe(200);
    for (const id of [J(6), J(7), J(41)]) expect((await w.req(`/jobs/${id}`)).status, id).toBe(404);
    expect(w.one('SELECT status, review_flag FROM jobs WHERE id = ?', J(6))).toEqual({ status: 'draft', review_flag: 'core_tech_rnd' });
  });

  it('기업 담당자: 공고와 지원자를 보고, 본사 소속 담당자는 국외 이전에 동의한 지원서만 연다', async () => {
    const w = world();
    const owner = await w.login('company');
    const jobs = await w.req('/biz/jobs', { cookie: owner });
    expect(jobs.status).toBe(200);
    expect(await jobs.text()).toContain('한국 시장 영업 매니저');
    expect((await w.req(`/biz/jobs/${J(1)}/applicants`, { cookie: owner })).status).toBe(200);
    expect((await w.req(`/biz/applications/${A(2)}`, { cookie: owner })).status).toBe(200); // 한국 담당자는 동의 없는 지원서도 연다
    expect((await w.req(`/biz/applications/${A(3)}`, { cookie: owner })).status).not.toBe(200); // 다른 기업의 지원서
    expect((await w.req('/admin', { cookie: owner })).status).toBe(403);

    const hq = await w.login('company_hq');
    expect((await w.req(`/biz/applications/${A(1)}`, { cookie: hq })).status).toBe(200);
    expect((await w.req(`/biz/applications/${A(2)}`, { cookie: hq })).status).not.toBe(200);
    // 열람은 기록에 남는다 (규칙 4)
    expect(w.n("SELECT COUNT(*) AS n FROM access_log WHERE target_id = ? AND actor_id = ?", A(1), U(12))).toBe(1);
    expect(w.n("SELECT COUNT(*) AS n FROM access_log WHERE target_id = ? AND actor_id = ?", A(2), U(12))).toBe(0);
  });

  it('확인 전 기업: 공고가 초안이고 게재되지 않는다', async () => {
    const w = world();
    const cookie = await w.login('company_new');
    expect((await w.req('/biz/jobs', { cookie })).status).toBe(200);
    expect(w.one('SELECT verify_status FROM companies WHERE id = ?', C(5))).toEqual({ verify_status: 'pending' });
    const res = await w.post(`/biz/jobs/${J(41)}/publish`, { rev: '0' }, { cookie });
    expect(res.status).not.toBe(500);
    expect(w.one('SELECT status FROM jobs WHERE id = ?', J(41))).toEqual({ status: 'draft' });
  });

  it('시연 계정은 탈퇴할 수 없다', async () => {
    const w = world();
    const cookie = await w.login('seeker');
    expect(await (await w.req('/my/account', { cookie })).text()).toContain('시연 계정은 여러 사람이 함께 쓰는 계정이라');
    const res = await w.post('/my/account/delete', { confirm: 'seeker.kim@demo.example' }, { cookie });
    expect(res.status).toBe(400);
    expect(w.one('SELECT status, email FROM users WHERE id = ?', U(1))).toEqual({ status: 'active', email: 'seeker.kim@demo.example' });
    expect(w.n('SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?', U(1))).toBe(2);
  });

  it('시연 계정은 2단계 인증을 켤 수 없다 (켜면 다른 사람이 쫓겨나고 시연 로그인이 막힌다)', async () => {
    const w = world();
    for (const key of ['seeker', 'company']) {
      const cookie = await w.login(key);
      const acct = await (await w.req('/my/account', { cookie })).text();
      expect(acct).toContain('2단계 인증을 켜거나 바꿀 수 없습니다');
      expect(acct).not.toContain('href="/my/account/2fa"');
      const page = await w.req('/my/account/2fa', { cookie });
      expect(page.status).toBe(403);
      expect(page.headers.get('cache-control') ?? '').toContain('no-store');
      for (const path of ['/my/account/2fa/start', '/my/account/2fa/confirm', '/my/account/2fa/reenrol', '/my/account/2fa/codes', '/my/account/2fa/off']) {
        expect((await w.post(path, { code: '123456' }, { cookie })).status, path).toBe(403);
      }
    }
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(0);
    expect(w.n('SELECT COUNT(*) AS n FROM users WHERE totp_secret IS NOT NULL')).toBe(0);
    // 다른 사람이 쓰던 시연 세션은 그대로 살아 있다
    const a = await w.login('seeker');
    const b = await w.login('seeker');
    expect((await w.req('/my', { cookie: a })).status).toBe(200);
    expect((await w.req('/my', { cookie: b })).status).toBe(200);
  });
});

describe.skipIf(!hasSqlite)('되돌리기', () => {
  /** 방문자가 시연 계정으로 해 놓은 일 + 시연 계정이 아닌 회원이 시연 공고에 낸 지원. */
  function mess(w: ReturnType<typeof world>) {
    const x = (sql: string, ...a: unknown[]) => w.raw.prepare(sql).run(...(a as never[]));
    x("UPDATE jobs SET title_ko = '바뀐 제목', status = 'closed' WHERE id = ?", J(1));
    x('DELETE FROM resumes WHERE id = ?', R(2));
    x("INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES ('extra-r', ?, '방문자가 만든 것', 0, 'v1.a.b', NULL, 5, 5)", U(1));
    x("UPDATE applications SET status = 'withdrawn', resume_snapshot = '' WHERE id = ?", A(1));
    x("INSERT INTO application_events (id, application_id, event, actor_id, at) VALUES ('extra-e', ?, 'withdrawn', ?, 9)", A(1), U(1));
    x("UPDATE companies SET name_ko = '낙서', profile_ko = '낙서' WHERE id = ?", C(1));
    x('DELETE FROM company_members WHERE user_id = ?', U(12));
    x("INSERT INTO company_invites (id, company_id, email, is_hq, invited_by, created_at) VALUES ('extra-i', ?, 'someone@example.test', 0, ?, 5)", C(1), U(11));
    x("INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, created_at) VALUES ('extra-d', 'company', ?, 'biz_cert', 'vdocs/company/x/extra.pdf', 'pending', 5)", C(5));
    w.store.set('vdocs/company/x/extra.pdf', new Uint8Array([1]));
    x("INSERT INTO alerts (id, seeker_id, filter_json, frequency, created_at) VALUES ('extra-al', ?, '{}', 'daily', 5)", U(2));
    x("INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) VALUES ('h', 'extra-al', 5)");
    // 시연 기업 계정으로 만든 공고 둘: 하나는 지원이 없고, 하나는 시연 계정이 아닌 회원의 지원이 달려 있다
    const job = (id: string) => x("INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, created_at, updated_at) VALUES (?, ?, ?, 'office', '방문자 공고', '본문', 'approved', 'published', 5, 5, 5)", id, C(1), U(11));
    job('11111111-1111-4111-8111-111111111111');
    job('22222222-2222-4222-8222-222222222222');
    x("INSERT INTO users (id, email, role, status, created_at) VALUES ('visitor', 'fake.visitor@example.test', 'seeker', 'active', 5)");
    x("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status, status_changed_at, created_at) VALUES ('v-app-1', '22222222-2222-4222-8222-222222222222', 'visitor', 'v1.q.w', 'submitted', 6, 6)");
    x("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status, status_changed_at, created_at) VALUES ('v-app-2', ?, 'visitor', 'v1.q.w', 'submitted', 6, 6)", J(2));
    x("INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES ('v-res', 'visitor', '방문자 이력서', 1, 'v1.q.w', NULL, 5, 5)");
  }
  const snapshot = (w: ReturnType<typeof world>) => ({
    jobs: w.raw.prepare('SELECT id, title_ko, status, company_id, review_flag FROM jobs ORDER BY id').all().map((r) => ({ ...r })),
    companies: w.raw.prepare('SELECT id, name_ko, profile_ko, verify_status FROM companies ORDER BY id').all().map((r) => ({ ...r })),
    members: w.raw.prepare('SELECT company_id, user_id, member_role, is_hq FROM company_members ORDER BY company_id, user_id').all().map((r) => ({ ...r })),
    users: w.raw.prepare("SELECT id, email, role, status FROM users WHERE id LIKE 'de30%' ORDER BY id").all().map((r) => ({ ...r })),
    resumes: w.raw.prepare("SELECT id, user_id, title, is_default FROM resumes WHERE user_id LIKE 'de30%' ORDER BY id").all().map((r) => ({ ...r })),
    apps: w.raw.prepare("SELECT id, job_id, seeker_id, status FROM applications WHERE seeker_id LIKE 'de30%' ORDER BY id").all().map((r) => ({ ...r })),
    events: w.raw.prepare('SELECT application_id, event, actor_id FROM application_events ORDER BY id').all().map((r) => ({ ...r })),
    docs: w.raw.prepare('SELECT id, owner_id, review_status FROM verification_docs ORDER BY id').all().map((r) => ({ ...r })),
  });

  it('하루가 지난 뒤의 시연 로그인은 시연 데이터를 처음 모습으로 되돌린다 (시연 계정이 아닌 회원의 것은 그대로)', async () => {
    const w = world();
    await w.login('seeker');
    const before = snapshot(w);
    mess(w);
    expect(snapshot(w)).not.toEqual(before);
    w.ageStamp();
    await w.login('company');

    const after = snapshot(w);
    // 고정 목록 밖의 공고: 지원이 없던 것은 지워지고, 다른 회원의 지원이 달린 것은 마감만 된다
    expect(after.jobs.filter((j) => !String(j.id).startsWith('de30'))).toEqual([
      { id: '22222222-2222-4222-8222-222222222222', title_ko: '방문자 공고', status: 'closed', company_id: C(1), review_flag: null },
    ]);
    expect({ ...after, jobs: after.jobs.filter((j) => String(j.id).startsWith('de30')) }).toEqual(before);
    for (const t of ['company_invites', 'alerts', 'alert_unsub_tokens']) expect(w.n(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM resumes WHERE id = 'extra-r'")).toBe(0);
    // 방문자가 올린 서류 파일은 지워지고, 예시 서류 파일은 그대로 있다
    expect(w.store.has('vdocs/company/x/extra.pdf')).toBe(false);
    expect(w.store.size).toBe(DEMO_COMPANIES.filter((c) => c.wantVerified).length);
    // 시연 계정이 아닌 회원: 계정·이력서·지원이 그대로다
    expect(w.one("SELECT email, status FROM users WHERE id = 'visitor'")).toEqual({ email: 'fake.visitor@example.test', status: 'active' });
    expect(w.n("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 'visitor'")).toBe(1);
    expect(w.n("SELECT COUNT(*) AS n FROM applications WHERE seeker_id = 'visitor'")).toBe(2);
    // 필수 동의는 회원마다 한 벌만 남는다
    expect(w.n("SELECT COUNT(*) AS n FROM consents WHERE type IN ('terms','privacy')")).toBe(DEMO_USERS.length * 2);
    const stamp = parseDemoStamp(String(w.one('SELECT value FROM site_settings WHERE key = ?', DEMO_STAMP_KEY)!.value))!;
    expect(stamp.at).toBeGreaterThan(1000 + DEMO_RESET_AFTER);
  });

  it('하루가 지나지 않았으면 되돌리지 않는다 (다른 사람이 쓰는 중일 수 있다)', async () => {
    const w = world();
    await w.login('seeker');
    w.raw.prepare("UPDATE jobs SET title_ko = '바뀐 제목' WHERE id = ?").run(J(1));
    await w.login('company');
    await w.login('seeker');
    expect(w.one('SELECT title_ko FROM jobs WHERE id = ?', J(1))).toEqual({ title_ko: '바뀐 제목' });
    expect(w.n('SELECT COUNT(*) AS n FROM sessions')).toBe(3);
  });

  it('고른 계정을 쓸 수 없으면 바로 되돌린다 — 관리자로 바뀌어 있어도 관리자로 들어오지 못한다', async () => {
    const w = world();
    await w.login('seeker');
    w.raw.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(U(2));
    await w.login('seeker_new');
    expect(w.one('SELECT status FROM users WHERE id = ?', U(2))).toEqual({ status: 'active' });

    w.raw.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(U(1));
    const cookie = await w.login('seeker');
    expect(w.one('SELECT role FROM users WHERE id = ?', U(1))).toEqual({ role: 'seeker' });
    expect((await w.req('/admin', { cookie })).status).toBe(403);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE mfa != 0')).toBe(0);
  });

  it('되돌리기는 시연 회원의 2단계 인증 흔적을 모두 지운다 (화면이 막기 전에 남은 것이 있어도 시연 로그인이 다시 된다)', async () => {
    const w = world();
    await w.login('seeker');
    const now = 2_000_000_000;
    w.raw.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 5, totp_enabled_at = ? WHERE id = ?').run('v1.fake', now, U(1));
    w.raw.prepare('INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?,?,?,NULL,?)').run('rc-demo-1', U(1), 'h', now);
    // 2단계 인증이 켜져 있으면 시연 로그인 세션(mfa = 0)은 로그인으로 인정되지 않는다 → 되돌리기 전에는 쓸 수 없음
    const stuck = await w.login('seeker');
    expect((await w.req('/my', { cookie: stuck })).status).not.toBe(200);
    w.ageStamp();
    const cookie = await w.login('seeker');
    expect(w.one('SELECT totp_secret, totp_last_step, totp_enabled_at FROM users WHERE id = ?', U(1))).toEqual({ totp_secret: null, totp_last_step: null, totp_enabled_at: null });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ?', U(1))).toBe(0);
    expect((await w.req('/my', { cookie })).status).toBe(200);
  });

  it('여러 번 실행해도 결과가 같다', async () => {
    const w = world();
    await w.login('seeker');
    const a = snapshot(w);
    expect(await seedDemo(w.env)).toBe(true);
    expect(await seedDemo(w.env)).toBe(true);
    expect(snapshot(w)).toEqual(a);
    expect(w.n('SELECT COUNT(*) AS n FROM application_events')).toBe(DEMO_APPLICATIONS.reduce((k, x) => k + x.events.length, 0));
    expect(w.n('SELECT COUNT(*) AS n FROM consents')).toBe(DEMO_USERS.length * 2 + w.n('SELECT COUNT(*) AS n FROM applications WHERE cross_border_consent_at IS NOT NULL'));
  });
});

describe.skipIf(!hasSqlite)('시연 주소로는 메일을 보내지 않는다', () => {
  it('Resend 를 부르지 않고 기록만 남긴다. 테스트 서버에서는 보낸 것으로, 운영에서는 실패로 처리한다', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    for (const [appEnv, ok] of [['test', true], ['dev', true], ['production', false]] as const) {
      const w = world({ APP_ENV: appEnv, RESEND_API_KEY: 're_fake' });
      expect(await sendMail(w.env, { to: 'seeker.kim@demo.example', subject: 's', text: 't', template: 'interview' })).toBe(ok);
      expect(w.one('SELECT template, result FROM email_log')).toEqual({ template: 'interview', result: 'demo_address' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // 그 밖의 주소는 전과 같이 보낸다
    const w = world({ RESEND_API_KEY: 're_fake' });
    expect(await sendMail(w.env, { to: 'fake.person@example.test', subject: 's', text: 't', template: 'x' })).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('설정 점검', () => {
  const GOOD = {
    APP_ENV: 'production', ENC_KEY, SESSION_PEPPER: 'a-long-enough-pepper-value', APP_ORIGIN: 'https://jobs.example.test', MAIL_FROM: 'x@example.test',
    RESEND_API_KEY: 'k', REGISTRATION_NO: '1', OPERATOR_DOMAINS: 'example.test', DB: {}, FILES: {}, ANTHROPIC_API_KEY: 'k',
  };
  const demo = (over: Record<string, unknown>) => configChecks({ ...GOOD, ...over } as never, { ko: 0, zh: 0 }).find((c) => c.id === 'demo')!;
  it('/admin/system: 운영에서 켜져 있으면 문제, 테스트에서 켜져 있으면 알림, 꺼져 있으면 정상', () => {
    expect(demo({})).toEqual({ id: 'demo', level: 'ok', code: 'ok' });
    expect(demo({ DEMO_LOGIN: 'off' }).level).toBe('ok');
    expect(demo({ DEMO_LOGIN: 'on' })).toEqual({ id: 'demo', level: 'problem', code: 'on_production' });
    expect(demo({ DEMO_LOGIN: 'on', APP_ENV: 'test' })).toEqual({ id: 'demo', level: 'warning', code: 'on' });
  });
  it('배포 전 점검: 운영 구역에 DEMO_LOGIN 이 있으면 배포를 막는다 (테스트 구역은 막지 않는다)', () => {
    const cfg = (prodVars: Record<string, unknown>) => ({
      name: 'recruit-test', vars: { APP_ENV: 'test', DEMO_LOGIN: 'on' },
      env: { production: { workers_dev: false, routes: [{ pattern: 'jobs.example.test', custom_domain: true }],
        vars: { APP_ENV: 'production', APP_ORIGIN: 'https://jobs.example.test', REGISTRATION_NO: '제2026-1호', ...prodVars } } },
    });
    expect(configIssues(cfg({}), 'production').errors).toEqual([]);
    expect(configIssues(cfg({ DEMO_LOGIN: 'off' }), 'production').errors).toEqual([]);
    expect(configIssues(cfg({ DEMO_LOGIN: 'on' }), 'production').errors.join('\n')).toContain('DEMO_LOGIN');
    expect(configIssues(cfg({ DEMO_LOGIN: '' }), 'production').errors.join('\n')).toContain('DEMO_LOGIN');
    expect(configIssues(cfg({}), 'test').errors).toEqual([]);
  });
});
