// T-11 화면: 약관·개인정보처리방침, 동의 확인(미들웨어)·동의 화면, 계정 화면, 회원 탈퇴 — app.fetch 로 라우트 전체를 돈다.
// SQLite 메모리 DB(test/sqlite-d1.ts) + Map 으로 만든 가짜 R2. 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/consent';
import { PUBLIC_FILES } from '../src/lib/static-files';
import { PRIVACY } from '../src/legal/privacy';
import { TERMS } from '../src/legal/terms';
import { hasDb, migratedDb } from './pg-test-db';
import type { Db } from '../src/db/types';

const ENC_KEY = b64url(new Uint8Array(32).fill(5)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';
const NO_STORE = 'private, no-store';
const J1 = '0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f';
const J2 = '1c8d7b63-5d2f-4e1f-8b62-1f4e2d3e4f50';

// 가짜 계정 (콘솔에 나오면 안 되는 값)
const S1 = 'fake.seeker1@example.test';
const S2 = 'fake.seeker2@example.test';

type Who = 's1' | 's2' | 'owner' | 'member' | 'solo' | 'adm';
const EMAILS: Record<Who, string> = {
  s1: S1, s2: S2, owner: 'fake.owner@example.test', member: 'fake.member@example.test', solo: 'fake.solo@example.test', adm: 'fake.adm@example.test',
};

function world() {
  const { raw, d1 } = migratedDb();
  const roles: Record<Who, string> = { s1: 'seeker', s2: 'seeker', owner: 'company', member: 'company', solo: 'company', adm: 'admin' };
  for (const [id, role] of Object.entries(roles)) {
    raw.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?,?,?,'active',0)").run(id, EMAILS[id as Who], role);
  }
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0), ('c2','혼자기업','kr_entity','verified',0)`);
  raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','owner','owner',0,0), ('c1','member','member',0,0), ('c2','solo','owner',0,0)`);
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, created_at, updated_at) VALUES
    ('${J1}','c1','owner','office','영업','본문','approved','published',1,0,0), ('${J2}','c2','solo','office','혼자공고','본문','approved','published',1,0,0)`);
  raw.exec(`INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES
    ('r1','s1','기본',1,'v1.x.y','rfiles/r1',0,0), ('r9','s2','남의것',1,'v1.x.y','rfiles/r9',0,0)`);
  raw.exec(`INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, file_r2_key, status, status_changed_at, created_at) VALUES
    ('a1','${J1}','s1','v1.snap.1','rfiles/a1','submitted',10,10), ('a2','${J2}','s1','v1.snap.2',NULL,'rejected',20,10), ('b1','${J1}','s2','v1.snap.3','rfiles/b1','submitted',10,10)`);
  raw.exec("INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES ('l1','owner','company','application','a1',NULL,11)");
  const store = new Map<string, Uint8Array>();
  for (const k of ['rfiles/r1', 'rfiles/a1', 'rfiles/r9', 'rfiles/b1']) store.set(k, new Uint8Array([1, 2, 3]));
  const FILES = {
    put: async (k: string, v: Uint8Array) => { store.set(k, v); },
    get: async (k: string) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.buffer } : null),
    delete: async (k: string) => { store.delete(k); },
  };
  // 실행된 SQL 을 모은다 (비로그인 화면이 consents 를 읽지 않는지 확인용)
  const sqls: string[] = [];
  const db = {
    prepare: (sql: string) => { sqls.push(sql); return d1.prepare(sql); },
    batch: (s: never) => d1.batch(s),
  } as unknown as Db;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '', MAIL_FROM: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const tokens = new Map<string, string>();
  const login = async (who: Who) => {
    if (!tokens.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      tokens.set(who, token);
    }
    return tokens.get(who)!;
  };
  const cookieOf = async (who: Who | null, lang: string, sid?: string) => {
    if (sid) return { cookie: `sid=${sid}; lang=${lang}` };
    return who ? { cookie: `sid=${await login(who)}; lang=${lang}` } : { cookie: `lang=${lang}` };
  };
  const get = async (path: string, who: Who | null = 's1', o: { lang?: string; sid?: string; method?: string } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method: o.method ?? 'GET', headers: await cookieOf(who, o.lang ?? 'ko', o.sid) }) as never, env);
  const post = async (path: string, form: Record<string, string> = {}, who: Who | null = 's1', o: { lang?: string; sid?: string } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST', body: new URLSearchParams(form),
      headers: { ...(await cookieOf(who, o.lang ?? 'ko', o.sid)), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, env);
  const agree = (who: string, terms = TERMS_VERSION, privacy = PRIVACY_VERSION) => {
    raw.prepare("INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?,'terms',?,NULL,1)").run(`t-${who}-${terms}`, who, terms);
    raw.prepare("INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?,'privacy',?,NULL,1)").run(`p-${who}-${privacy}`, who, privacy);
  };
  const one = (sql: string, ...a: unknown[]) => { const r = raw.prepare(sql).get(...(a as never[])); return r ? { ...r } : undefined; };
  const n = (sql: string, ...a: unknown[]) => Number(raw.prepare(sql).get(...(a as never[]))!.n);
  return { raw, env, store, sqls, get, post, agree, one, n };
}

let logSpy: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { logSpy = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})); });
afterEach(() => {
  // 콘솔에 이메일·개인정보가 나오지 않는다 (인증코드 메일은 dev 에서 콘솔로 나가므로 그 줄만 뺀다)
  const out = logSpy.flatMap((s) => s.mock.calls.flat().map(String)).filter((x) => !x.includes('인증코드') && !/\[mail]|mail:/.test(x)).join('\n');
  for (const s of [...Object.values(EMAILS), 'v1.snap', 'rfiles/']) expect(out).not.toContain(s);
  logSpy.forEach((s) => s.mockRestore());
});

describe('public/ 정적 파일', () => {
  it('public/ 의 모든 파일이 동의 확인을 건너뛰는 목록에 있다', async () => {
    const fsMod = 'node:fs';
    const fs = (await import(fsMod)) as { readdirSync(p: string): string[] };
    for (const f of fs.readdirSync('public')) expect(PUBLIC_FILES.has(`/${f}`), f).toBe(true);
  });
});

describe.skipIf(!hasDb)('약관·개인정보처리방침', () => {
  it('한국어·중국어로 제목·시행일·모든 조항 제목·항목을 그리고, 주소는 글자 그대로', async () => {
    const w = world();
    for (const [path, doc] of [['/terms', TERMS], ['/privacy', PRIVACY]] as const) {
      for (const lang of ['ko', 'zh'] as const) {
        const res = await w.get(path, null, { lang });
        expect(res.status).toBe(200);
        const html = await res.text();
        const d = doc[lang];
        expect(html).toContain(`<h1>${d.title}</h1>`);
        expect(html).toContain(d.effective);
        for (const s of d.sections) expect(html).toContain(`<h2>${s.h}</h2>`);
        expect(html.match(/<li>/g)!.length).toBeGreaterThanOrEqual(d.sections.reduce((k, s) => k + s.items.length, 0));
        expect(html).not.toContain('<a href="https://');
        // 바닥글 링크 (모든 화면)
        expect(html).toContain('href="/terms"');
        expect(html).toContain('href="/privacy"');
      }
    }
    expect(await (await w.get('/privacy', null)).text()).toContain('https://resend.com/legal/privacy-policy');
  });
  it('비로그인은 공개 캐시 머리글, 로그인하면 no-store', async () => {
    const w = world();
    expect((await w.get('/terms', null)).headers.get('cache-control')).toBe('public, max-age=60');
    expect((await w.get('/terms', 's1')).headers.get('cache-control')).toBe(NO_STORE);
  });
  it('로그인 화면에서 두 문서로 연결된다', async () => {
    const w = world();
    const html = await (await w.get('/login', null)).text();
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe.skipIf(!hasDb)('동의 확인 (미들웨어)', () => {
  it('비로그인은 확인하지 않고, /jobs 는 consents 를 읽지 않는다', async () => {
    const w = world();
    for (const p of ['/', '/jobs', `/jobs/${J1}`, '/companies', '/terms']) {
      const res = await w.get(p, null);
      expect(res.status, p).toBe(200);
    }
    expect((await w.get('/my', null)).headers.get('location')).toBe('/login');
    expect(w.sqls.filter((s) => s.includes('consents'))).toEqual([]);
  });
  it('동의 없는 구직자·기업 담당자: GET 은 /consent?next=… , POST 는 403 (no-store)', async () => {
    const w = world();
    for (const [who, path] of [['s1', '/my/resumes'], ['s1', '/jobs?location=seoul'], ['owner', '/biz/jobs'], ['s1', '/']] as const) {
      const res = await w.get(path, who);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location')).toBe(`/consent?next=${encodeURIComponent(path)}`);
      expect(res.headers.get('cache-control')).toBe(NO_STORE);
    }
    const head = await w.get('/my/resumes', 's1', { method: 'HEAD' });
    expect(head.status).toBe(302);
    const p = await w.post('/my/resumes/r1/default', {}, 's1');
    expect(p.status).toBe(403);
    expect(p.headers.get('cache-control')).toBe(NO_STORE);
    expect(await p.text()).toContain('href="/consent"');
    const pb = await w.post('/biz/members/invite', { email: 'x@example.test' }, 'owner');
    expect(pb.status).toBe(403);
    expect(w.n('SELECT COUNT(*) AS n FROM company_invites')).toBe(0);
    expect(w.n('SELECT COUNT(*) AS n FROM consents')).toBe(0);
  });
  it('동의 없이도 열리는 곳: 문서·동의 화면·언어·로그아웃·계정·탈퇴 확인·정적 파일', async () => {
    const w = world();
    for (const path of ['/terms', '/privacy', '/consent', '/my/account', '/my/account/delete']) {
      const res = await w.get(path, 's1');
      expect(res.status, path).toBe(200);
    }
    expect((await w.get('/lang/zh?to=/terms', 's1')).headers.get('location')).toBe('/terms');
    expect((await w.get('/app.css', 's1')).headers.get('location')).toBeNull();
    const out = await w.post('/logout', {}, 's1');
    expect([out.status, out.headers.get('location')]).toEqual([302, '/']);
    expect(w.n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 's1'")).toBe(0);
  });
  it('관리자는 확인하지 않는다', async () => {
    const w = world();
    const res = await w.get('/admin/settings', 'adm'); // (/admin 첫 화면은 읽기 batch 를 써서 테스트용 SQLite 어댑터로는 그릴 수 없다)
    expect(res.status).toBe(200);
    expect((await w.get('/consent', 'adm')).headers.get('location')).toBe('/admin');
  });
  it('밖으로 나가는 주소는 next 로 받지 않는다 (/my 로)', async () => {
    const w = world();
    expect((await w.get('//evil.test/x', 's1')).headers.get('location')).toBe('/consent');
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', '/consent', '/login']) {
      const g = await w.get(`/consent?next=${encodeURIComponent(bad)}`, 's1');
      expect(await g.text()).toContain('name="next" value="/my"');
    }
    const r = await w.post('/consent', { terms: '1', privacy: '1', next: 'https://evil.test' }, 's1');
    expect([r.status, r.headers.get('location')]).toEqual([303, '/my']);
  });
});

describe.skipIf(!hasDb)('동의 화면', () => {
  it('비로그인은 /login, 화면의 체크 칸은 미리 체크되어 있지 않다', async () => {
    const w = world();
    expect((await w.get('/consent', null)).headers.get('location')).toBe('/login');
    const res = await w.get('/consent?next=%2Fmy%2Fresumes', 's1');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const html = await res.text();
    expect(html).toContain('name="terms"');
    expect(html).toContain('name="privacy"');
    expect(html).not.toContain('checked');
    expect(html).toContain('Cloudflare');
    expect(html).toContain('href="/my/account"');
    expect(html).toContain('name="next" value="/my/resumes"');
  });
  it('하나만 체크하면 오류이고 아무것도 기록하지 않는다. 둘 다 체크하면 두 줄을 남기고 next 로', async () => {
    const w = world();
    const bad = await w.post('/consent', { terms: '1', next: '/my/resumes' }, 's1');
    expect(bad.status).toBe(400);
    expect(bad.headers.get('cache-control')).toBe(NO_STORE);
    const html = await bad.text();
    expect(html).toContain('개인정보 수집·이용');
    expect(html).not.toContain('checked');
    expect(w.n('SELECT COUNT(*) AS n FROM consents')).toBe(0);
    const ok = await w.post('/consent', { terms: '1', privacy: '1', next: '/my/resumes' }, 's1');
    expect([ok.status, ok.headers.get('location'), ok.headers.get('cache-control')]).toEqual([303, '/my/resumes', NO_STORE]);
    const rows = w.raw.prepare("SELECT type, version, ref_id, withdrawn_at FROM consents WHERE user_id = 's1' ORDER BY type").all().map((r) => ({ ...r }));
    expect(rows).toEqual([
      { type: 'privacy', version: PRIVACY_VERSION, ref_id: null, withdrawn_at: null },
      { type: 'terms', version: TERMS_VERSION, ref_id: null, withdrawn_at: null },
    ]);
    expect((await w.get('/my/resumes', 's1')).status).toBe(200);
    // 다시 와도 새 줄이 생기지 않는다
    expect((await w.get('/consent?next=%2Fmy%2Fapplications', 's1')).headers.get('location')).toBe('/my/applications');
    await w.post('/consent', { terms: '1', privacy: '1' }, 's1');
    expect(w.n('SELECT COUNT(*) AS n FROM consents')).toBe(2);
  });
  it('판이 바뀌면 다시 묻고, 받지 않은 종류만 기록한다', async () => {
    const w = world();
    w.agree('s1', 'old-version', PRIVACY_VERSION);
    const g = await w.get('/my/resumes', 's1');
    expect(g.headers.get('location')).toBe('/consent?next=%2Fmy%2Fresumes');
    const html = await (await w.get('/consent', 's1')).text();
    expect(html).toContain('name="terms"');
    expect(html).not.toContain('name="privacy"');
    const ok = await w.post('/consent', { terms: '1', next: '/my/resumes' }, 's1');
    expect(ok.headers.get('location')).toBe('/my/resumes');
    expect(w.raw.prepare("SELECT type, version FROM consents WHERE user_id = 's1' ORDER BY type, version").all().map((r) => ({ ...r }))).toEqual([
      { type: 'privacy', version: PRIVACY_VERSION }, { type: 'terms', version: TERMS_VERSION }, { type: 'terms', version: 'old-version' },
    ]);
    // 계정 화면은 판을 보여 준다
    const acct = await (await w.get('/my/account', 's1')).text();
    expect(acct).toContain(TERMS_VERSION);
  });
  it('중국어 화면', async () => {
    const w = world();
    const html = await (await w.get('/consent', 's1', { lang: 'zh' })).text();
    expect(html).toContain('我同意使用条款');
    expect(html).toContain('境外处理');
  });
});

describe.skipIf(!hasDb)('계정 화면', () => {
  it('이메일·유형·동의 내역·문서, 링크가 /my·/biz·머리글에 있다 (no-store)', async () => {
    const w = world();
    w.agree('s1');
    w.agree('solo');
    const res = await w.get('/my/account', 's1');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const html = await res.text();
    expect(html).toContain(S1);
    expect(html).toContain('구직자');
    expect(html).toContain(`동의함 (판 ${TERMS_VERSION})`);
    expect(html).toContain('href="/my/account/delete"');
    expect(await (await w.get('/my', 's1')).text()).toContain('href="/my/account"');
    expect(await (await w.get('/biz', 'solo')).text()).toContain('href="/my/account"');
    expect((await w.get('/my/account', null)).headers.get('location')).toBe('/login');
    expect((await w.get('/my/account', null)).headers.get('cache-control')).toBe(NO_STORE);
  });
  it('관리자·다른 담당자가 있는 대표는 탈퇴 입구 대신 이유가 보이고, 탈퇴 요청도 막힌다', async () => {
    const w = world();
    w.agree('owner');
    const a = await (await w.get('/my/account', 'adm')).text();
    expect(a).toContain('운영자 계정은 이 화면에서 탈퇴할 수 없습니다');
    expect(a).not.toContain('href="/my/account/delete"');
    const o = await (await w.get('/my/account', 'owner')).text();
    expect(o).toContain('다른 담당자가 있는 기업의 대표 담당자는 탈퇴할 수 없습니다');
    expect(o).toContain('href="/biz/members"');
    expect(await (await w.get('/my/account/delete', 'owner')).text()).not.toContain('name="confirm"');
    const p = await w.post('/my/account/delete', { confirm: EMAILS.owner }, 'owner');
    expect(p.status).toBe(400);
    expect(await p.text()).toContain('/biz/members');
    expect(w.one("SELECT status FROM users WHERE id = 'owner'")).toEqual({ status: 'active' });
    const pa = await w.post('/my/account/delete', { confirm: EMAILS.adm }, 'adm');
    expect(pa.status).toBe(400);
    expect(w.one("SELECT status FROM users WHERE id = 'adm'")).toEqual({ status: 'active' });
  });
  it('중국어 화면', async () => {
    const w = world();
    expect(await (await w.get('/my/account', 's1', { lang: 'zh' })).text()).toContain('注销账号');
    expect(await (await w.get('/my/account/delete', 's1', { lang: 'zh' })).text()).toContain('为确认，请输入您的登录邮箱');
  });
});

describe.skipIf(!hasDb)('회원 탈퇴', () => {
  it('이메일이 다르면 아무것도 바뀌지 않는다', async () => {
    const w = world();
    const page = await (await w.get('/my/account/delete', 's1')).text();
    expect(page).toContain('저장한 이력서와 첨부파일이 모두 삭제됩니다');
    const res = await w.post('/my/account/delete', { confirm: S2 }, 's1');
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(await res.text()).toContain('아무것도 삭제되지 않았습니다');
    expect(w.one("SELECT email, status FROM users WHERE id = 's1'")).toEqual({ email: S1, status: 'active' });
    expect(w.n("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1'")).toBe(1);
    expect(w.store.size).toBe(4);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('구직자: 익명화·이력서 삭제·지원서 내용 삭제(진행 중은 취소 이벤트)·R2 삭제·쿠키 삭제 → 안내가 있는 홈', async () => {
    const w = world();
    w.agree('s1');
    const before = await w.get('/my', 's1');
    expect(before.status).toBe(200);
    const res = await w.post('/my/account/delete', { confirm: ' Fake.Seeker1@Example.test ' }, 's1');
    expect([res.status, res.headers.get('location'), res.headers.get('cache-control')]).toEqual([303, '/?bye=1', NO_STORE]);
    expect(res.headers.get('set-cookie')).toMatch(/^sid=;.*Max-Age=0/);
    const u = w.one("SELECT email, status, last_login_at FROM users WHERE id = 's1'")!;
    expect(u.status).toBe('deleted');
    expect(u.email).toMatch(/^deleted-[0-9a-f-]{36}@deleted\.invalid$/);
    expect(w.n("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1'")).toBe(0);
    expect(w.one("SELECT status, resume_snapshot, file_r2_key FROM applications WHERE id = 'a1'")).toEqual({ status: 'withdrawn', resume_snapshot: '', file_r2_key: null });
    expect(w.one("SELECT status, resume_snapshot FROM applications WHERE id = 'a2'")).toEqual({ status: 'rejected', resume_snapshot: '' });
    expect(w.raw.prepare("SELECT application_id, event FROM application_events").all().map((r) => ({ ...r }))).toEqual([{ application_id: 'a1', event: 'withdrawn' }]);
    expect(w.n("SELECT COUNT(*) AS n FROM consents WHERE user_id = 's1' AND withdrawn_at IS NOT NULL")).toBe(2);
    expect(w.n('SELECT COUNT(*) AS n FROM access_log')).toBe(1);
    expect([...w.store.keys()].sort()).toEqual(['rfiles/b1', 'rfiles/r9']);
    // 다른 회원은 그대로
    expect(w.one("SELECT resume_snapshot FROM applications WHERE id = 'b1'")).toEqual({ resume_snapshot: 'v1.snap.3' });
    // 예전 세션 쿠키로는 더 이상 로그인 상태가 아니다
    const old = await w.get('/my', 's1');
    expect(old.headers.get('location')).toBe('/login');
    // 홈: ?bye=1 은 캐시를 거치지 않고 안내를 보인다. 보통 홈은 캐시되고 안내가 없다
    const bye = await w.get('/?bye=1', null);
    expect(bye.headers.get('cache-control')).toBe(NO_STORE);
    expect(await bye.text()).toContain('탈퇴가 처리되었습니다');
    const home = await w.get('/', null);
    expect(home.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await home.text()).not.toContain('탈퇴가 처리되었습니다');
    expect(await (await w.get('/?bye=1', null, { lang: 'zh' })).text()).toContain('账号已注销');
  });
  it('같은 이메일로 다시 가입하면 새 계정이고, 동의를 다시 묻는다', async () => {
    const w = world();
    w.agree('s1');
    await w.post('/my/account/delete', { confirm: S1 }, 's1');
    const email = S1.toLowerCase();
    const code = '123456';
    w.raw.prepare('INSERT INTO auth_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?)')
      .run(email, await sha256Hex(`${PEPPER}|${email}|${code}`), 4_000_000_000, 0);
    const v = await w.post('/login/verify', { email, code, role: 'seeker' }, null);
    expect(v.headers.get('location')).toBe('/my');
    const sid = /sid=([^;]+)/.exec(v.headers.get('set-cookie') ?? '')![1]!;
    const fresh = w.one('SELECT id, status FROM users WHERE email = ?', email)!;
    expect(fresh.id).not.toBe('s1');
    expect(fresh.status).toBe('active');
    expect(w.n('SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?', fresh.id)).toBe(0);
    const my = await w.get('/my', null, { sid });
    expect(my.headers.get('location')).toBe('/consent?next=%2Fmy');
  });
  it('혼자 맡던 기업의 담당자: 게재 중 공고가 마감되고 소속이 지워진다', async () => {
    const w = world();
    const page = await (await w.get('/my/account/delete', 'solo')).text();
    expect(page).toContain('게재 중인 공고가 마감됩니다');
    const res = await w.post('/my/account/delete', { confirm: EMAILS.solo }, 'solo');
    expect(res.headers.get('location')).toBe('/?bye=1');
    expect(w.one(`SELECT status FROM jobs WHERE id = '${J2}'`)).toEqual({ status: 'closed' });
    expect(w.one(`SELECT status FROM jobs WHERE id = '${J1}'`)).toEqual({ status: 'published' });
    expect(w.n("SELECT COUNT(*) AS n FROM company_members WHERE user_id = 'solo'")).toBe(0);
    expect(w.n("SELECT COUNT(*) AS n FROM companies WHERE id = 'c2'")).toBe(1);
  });
  it('일반 담당자는 탈퇴할 수 있고 기업 공고는 남는다', async () => {
    const w = world();
    const res = await w.post('/my/account/delete', { confirm: EMAILS.member }, 'member');
    expect(res.headers.get('location')).toBe('/?bye=1');
    expect(w.one(`SELECT status FROM jobs WHERE id = '${J1}'`)).toEqual({ status: 'published' });
    expect(w.n("SELECT COUNT(*) AS n FROM company_members WHERE company_id = 'c1'")).toBe(1);
  });
});
