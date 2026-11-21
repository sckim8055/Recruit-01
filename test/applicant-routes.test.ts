// 지원자 관리 화면 (T-09a) — app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts) + Map 으로 만든 가짜 R2.
// 지원서는 구직자 화면(T-08)으로 실제로 내서 복사본이 제대로 암호화되게 한다. 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { AdminHome } from '../src/views/pages';
import { agreeRequired } from './consent-fixture';
import { hasSqlite, migratedDb } from './sqlite-d1';

const te = new TextEncoder();
const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';

// 가짜 개인정보 (목록·로그·관리자 GET 화면에 나오면 안 되는 값)
const NAME = '가짜열람대상이름';
const NAME2 = '가짜두번째지원자';
const EMAIL = 'fake.target@example.test';
const EMAIL2 = 'fake.second@example.test';
const PHONE = '010-1234-0000';
const HEADLINE = '원래소개문장';
const EDITED = '이번지원만고친소개';
const SECRET_IN_FILE = 'SECRET-APPLICANT-FILE-42';
const pdf = te.encode(`%PDF-1.4\n% ${SECRET_IN_FILE}\n1 0 obj\n<<>>\nendobj\n%%EOF`);
const SECRETS = [NAME, NAME2, EMAIL, EMAIL2, PHONE, HEADLINE, EDITED, SECRET_IN_FILE, 's1@example.test', 's2@example.test'];

const J1 = '11111111-1111-4111-8111-111111111111'; // c1: 한국 담당자(co) + 본사 담당자(hq1) → 동의 선택
const J9 = '99999999-9999-4999-8999-999999999999'; // c3 공고 (다른 기업)
const TITLE1 = '가짜 영업 매니저';

type Who = 's1' | 's2' | 'co' | 'hq1' | 'co3' | 'adm';

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0),
    ('co','co@example.test','company','active',0), ('hq1','hq1@example.test','company','active',0),
    ('co3','co3@example.test','company','active',0), ('adm','adm@example.test','admin','active',0)`);
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES
    ('c1','가짜전자','kr_entity','verified',0), ('c3','다른기업','kr_entity','verified',0)`);
  raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES
    ('c1','co','owner',0,0), ('c1','hq1','member',1,0), ('c3','co3','owner',0,0)`);
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_zh, title_ko, body_ko, contact_email, localize_status, status, published_at, created_at, updated_at, company_name_public) VALUES
    ('${J1}','c1','co','office','假销售经理','${TITLE1}','본문','hr@example-corp.test','approved','published',1,0,0,1),
    ('${J9}','c3','co3','office','其他职位','다른 공고','본문','hr3@example-corp.test','approved','published',1,0,0,1)`);
  const store = new Map<string, Uint8Array>();
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v.slice() : new Uint8Array(v)); },
    get: async (k: string) => {
      const v = store.get(k);
      return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), body: v } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const sessions = new Map<Who, string>();
  const cookie = async (who: Who | null, lang = 'ko'): Promise<Record<string, string>> => {
    if (!who) return { cookie: `lang=${lang}` };
    if (!sessions.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      agreeRequired(raw, who); // T-11 동의 확인을 통과하게 (test/consent-fixture.ts)
      sessions.set(who, token);
    }
    return { cookie: `sid=${sessions.get(who)}; lang=${lang}` };
  };
  const req = async (method: string, path: string, who: Who | null, extra: Record<string, string> = {}, lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(await cookie(who, lang)), ...extra } }) as never, env);
  const get = (path: string, who: Who | null = 'co', lang = 'ko') => req('GET', path, who, {}, lang);
  const post = async (path: string, form: FormData | Record<string, string> = {}, who: Who | null = 's1') => {
    const body = form instanceof FormData ? form : new URLSearchParams(form);
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { ...(await cookie(who)), origin: ORIGIN } }) as never, env);
  };
  const rows = (sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[])).map((r) => ({ ...r }));
  const logs = () => rows('SELECT actor_id, actor_role, target_type, target_id, reason FROM access_log ORDER BY at, rowid') as {
    actor_id: string; actor_role: string; target_type: string; target_id: string; reason: string | null;
  }[];
  const events = () => rows('SELECT application_id, event, actor_id FROM application_events ORDER BY at, rowid') as { application_id: string; event: string; actor_id: string }[];
  const statusOf = (id: string) => String(raw.prepare('SELECT status FROM applications WHERE id = ?').get(id)!.status);
  return { raw, env, store, req, get, post, logs, events, statusOf };
}
type World = ReturnType<typeof world>;

/** 구직자 화면으로 이력서를 만들고 J1 에 지원한다. 지원 id 를 돌려준다. */
async function applyAs(w: World, who: 's1' | 's2', o: { name: string; email: string; consent: boolean; withFile: boolean }) {
  const fd = new FormData();
  const fields = { title: '영업직용', name: o.name, chinese_level: 'business', years: '5', headline: HEADLINE, contact_email: o.email, phone: PHONE, desired_role: '영업', experience_text: '' };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('attachment', o.withFile ? new File([pdf], `${o.name}.pdf`, { type: 'application/pdf' }) : new File([], '', { type: 'application/octet-stream' }));
  if (!o.withFile) fd.set('experience_text', '경력 요약 가짜');
  expect((await w.post('/my/resumes/new', fd, who)).status).toBe(302);
  const resumeId = String(w.raw.prepare('SELECT id FROM resumes WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').get(who)!.id);
  const { title: _t, ...rest } = fields;
  const form: Record<string, string> = { resume_id: resumeId, ...rest, headline: EDITED, experience_text: o.withFile ? '' : '경력 요약 가짜' };
  if (o.withFile) form.include_file = '1';
  if (o.consent) form.consent = '1';
  const res = await w.post(`/jobs/${J1}/apply`, form, who);
  expect(res.status).toBe(302);
  return /\/my\/applications\/([0-9a-f-]{36})\?ok=/.exec(res.headers.get('location') ?? '')![1]!;
}

const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe.skipIf(!hasSqlite)('지원자 관리 (T-09a)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>, errSpy: ReturnType<typeof vi.spyOn>, warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    // console.log 는 dev 메일 출력뿐이고, 어디에도 구직자 정보가 없다.
    for (const call of logSpy.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line.startsWith('[mail:new_applicant]')).toBe(true);
      for (const s of SECRETS) expect(line).not.toContain(s);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).toEqual([]);
    vi.restoreAllMocks();
  });

  it('공고 목록·첫 화면의 숫자, 지원자 목록에는 개인정보·암호문이 없다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const b = await applyAs(w, 's2', { name: NAME2, email: EMAIL2, consent: true, withFile: false });
    w.raw.prepare('UPDATE applications SET created_at = created_at + 10 WHERE id = ?').run(b); // 같은 초에 냈으므로 순서를 분명히

    const home = await (await w.get('/biz')).text();
    expect(home).toContain('새 지원 2건');
    expect(home).toContain('전체 2건');
    const jobs = await (await w.get('/biz/jobs')).text();
    expect(jobs).toContain(`href="/biz/jobs/${J1}/applicants"`);
    expect(jobs).toContain('지원 2건');
    expect(jobs).toContain('새 지원 2건');

    const res = await w.get(`/biz/jobs/${J1}/applicants`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    for (const s of SECRETS) expect(html).not.toContain(s);
    const snaps = w.raw.prepare('SELECT resume_snapshot FROM applications').all().map((r) => String(r.resume_snapshot));
    for (const s of snaps) expect(html).not.toContain(s.slice(0, 40));
    expect(html).toContain(`href="/biz/applications/${a}"`);
    expect(html).toContain(`href="/biz/applications/${b}"`);
    expect(html).toContain('지원서를 열면 열람 기록이 남고');
    expect(html.indexOf(`/biz/applications/${a}`)).toBeLessThan(html.indexOf(`/biz/applications/${b}`)); // 지원 순서
    expect(html).toContain('새 지원');
    // 목록을 보는 것은 기록되지 않는다
    expect(w.logs()).toEqual([]);

    // 중국어 화면
    const zh = await (await w.get(`/biz/jobs/${J1}/applicants`, 'co', 'zh')).text();
    expect(zh).toContain('应聘者');
    expect(zh).toContain('打开申请资料');
    expect(zh).toContain('新申请');
    const zhJobs = await (await w.get('/biz/jobs', 'co', 'zh')).text();
    expect(zhJobs).toContain('申请 2 份');
  });

  it('한국 담당자가 열기: 내용, 기록 1줄 + viewed 1번 → 다시 열면 기록만. 구직자는 상태·열람 기록(역할만)을 본다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const res = await w.get(`/biz/applications/${a}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    for (const s of [NAME, EMAIL, PHONE, EDITED, `${NAME}.pdf`]) expect(html).toContain(s);
    expect(html).not.toContain(HEADLINE); // 이번 지원에서 고친 값이 보인다
    expect(html).toContain(`href="/biz/applications/${a}/file"`);
    expect(html).toContain('열람함');
    expect(w.logs()).toEqual([{ actor_id: 'co', actor_role: 'company', target_type: 'application', target_id: a, reason: null }]);
    expect(w.events().filter((e) => e.event === 'viewed')).toEqual([{ application_id: a, event: 'viewed', actor_id: 'co' }]);
    expect(w.statusOf(a)).toBe('viewed');

    expect((await w.get(`/biz/applications/${a}`)).status).toBe(200);
    expect(w.logs()).toHaveLength(2);
    expect(w.events().filter((e) => e.event === 'viewed')).toHaveLength(1);

    // 목록의 숫자: 새 지원 0
    expect(await (await w.get('/biz/jobs')).text()).not.toContain('새 지원 1건');

    // 구직자 화면
    const mine = await (await w.get(`/my/applications/${a}`, 's1')).text();
    expect(mine).toContain('기업이 열람함');
    expect(mine).toContain('열람 기록');
    expect((mine.match(/<td>기업 채용 담당자<\/td>/g) ?? []).length).toBe(2);
    expect(mine).not.toContain('co@example.test');
    expect(mine).not.toContain('운영자</td>');
    // 구직자 본인의 첨부 내려받기는 기록되지만 열람 기록 화면에는 나오지 않는다
    expect((await w.get(`/my/applications/${a}/file`, 's1')).status).toBe(200);
    const mine2 = await (await w.get(`/my/applications/${a}`, 's1')).text();
    expect((mine2.match(/<td>기업 채용 담당자<\/td>/g) ?? []).length).toBe(2);
  });

  it('구직자: 아직 아무도 열지 않았으면 빈 안내', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const mine = await (await w.get(`/my/applications/${a}`, 's1')).text();
    expect(mine).toContain('아직 열람 기록이 없습니다');
  });

  it('첨부파일: 바이트가 같고 기록 1줄, 상태는 바꾸지 않는다. HEAD·미리 가져오기는 기록하지 않는다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const file = await w.get(`/biz/applications/${a}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await bytes(file)).toEqual(pdf);
    expect(w.logs()).toHaveLength(1);
    expect(w.events().filter((e) => e.event === 'viewed')).toEqual([]);
    expect(w.statusOf(a)).toBe('submitted');

    for (const path of [`/biz/applications/${a}`, `/biz/applications/${a}/file`, `/biz/jobs/${J1}/applicants`]) {
      const head = await w.req('HEAD', path, 'co');
      expect(head.status, path).toBe(405);
      expect(head.headers.get('allow')).toBe('GET');
      expect(head.headers.get('cache-control')).toBe('private, no-store');
      const pre = await w.req('GET', path, 'co', { 'sec-purpose': 'prefetch;prerender' });
      expect(pre.status, path).toBe(503);
      const pre2 = await w.req('GET', path, 'co', { purpose: 'prefetch' });
      expect(pre2.status, path).toBe(503);
    }
    expect(w.logs()).toHaveLength(1);
    expect(w.statusOf(a)).toBe('submitted');
  });

  it('본사 담당자: 동의 없는 지원은 안내만(내용·기록 없음), 동의한 지원은 열린다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const b = await applyAs(w, 's2', { name: NAME2, email: EMAIL2, consent: true, withFile: false });
    const list = await (await w.get(`/biz/jobs/${J1}/applicants`, 'hq1')).text();
    expect(list).toContain('국외 이전 동의 없음 — 한국 담당자만 열람 가능');
    expect(list).not.toContain(`href="/biz/applications/${a}"`);
    expect(list).toContain(`href="/biz/applications/${b}"`);

    const blocked = await w.get(`/biz/applications/${a}`, 'hq1');
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('cache-control')).toBe('private, no-store');
    const bh = await blocked.text();
    expect(bh).toContain('한국 소속 담당자만 열 수 있습니다');
    for (const s of SECRETS) expect(bh).not.toContain(s);
    expect((await w.get(`/biz/applications/${a}/file`, 'hq1')).status).toBe(404);
    expect(w.logs()).toEqual([]);
    expect(w.statusOf(a)).toBe('submitted');

    const ok = await w.get(`/biz/applications/${b}`, 'hq1');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain(NAME2);
    expect(w.logs()).toEqual([{ actor_id: 'hq1', actor_role: 'company', target_type: 'application', target_id: b, reason: null }]);
    expect(w.statusOf(b)).toBe('viewed');
  });

  it('다른 기업·구직자·비로그인은 닿지 않는다 (404 / 403 / 로그인, 기록 없음)', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    for (const path of [`/biz/jobs/${J1}/applicants`, `/biz/applications/${a}`, `/biz/applications/${a}/file`]) {
      const r = await w.get(path, 'co3');
      expect(r.status, path).toBe(404);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      const s1 = await w.get(path, 's1');
      expect(s1.status, path).toBe(403);
      expect(s1.headers.get('cache-control')).toBe('private, no-store');
      const anon = await w.get(path, null);
      expect([anon.status, anon.headers.get('location')], path).toEqual([302, '/login']);
      expect(anon.headers.get('cache-control')).toBe('private, no-store');
    }
    // 없는 지원 id 도 같은 404
    expect((await w.get('/biz/applications/00000000-0000-4000-8000-000000000000', 'co')).status).toBe(404);
    // 다른 기업 담당자는 자기 공고 목록에서 지원이 없다
    expect(await (await w.get(`/biz/jobs/${J9}/applicants`, 'co3')).text()).toContain('아직 지원이 없습니다');
    expect(w.logs()).toEqual([]);
    expect(w.statusOf(a)).toBe('submitted');
  });

  it('취소된 지원: 목록은 글자만(링크 없음), 직접 주소는 삭제 안내, 기록 없음', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    expect((await w.post(`/my/applications/${a}/withdraw`, {}, 's1')).status).toBe(302);
    const list = await (await w.get(`/biz/jobs/${J1}/applicants`)).text();
    expect(list).toContain('지원 취소됨');
    expect(list).not.toContain(`href="/biz/applications/${a}"`);
    const page = await w.get(`/biz/applications/${a}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('지원 내용과 첨부파일이 삭제되었습니다');
    expect((await w.get(`/biz/applications/${a}/file`)).status).toBe(404);
    // 다른 기업에는 여전히 404
    expect((await w.get(`/biz/applications/${a}`, 'co3')).status).toBe(404);
    expect(w.logs()).toEqual([]);
    // 숫자에서 빠진다
    expect(await (await w.get('/biz/jobs')).text()).toContain('지원 없음');
    // 구직자 화면에는 열람 기록 칸이 없다
    expect(await (await w.get(`/my/applications/${a}`, 's1')).text()).not.toContain('열람 기록');
  });

  it('관리자: GET 은 개인정보·기록 없음, 사유 없는 POST 는 오류, 사유가 있으면 내용·기록(사유)·상태 그대로', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    const g = await w.get(`/admin/applications/${a}`, 'adm');
    expect(g.status).toBe(200);
    expect(g.headers.get('cache-control')).toBe('private, no-store');
    const gh = await g.text();
    for (const s of SECRETS) expect(gh).not.toContain(s);
    expect(gh).toContain(TITLE1);
    expect(gh).toContain('name="reason"');
    expect(gh).toContain(`action="/admin/applications/${a}/open"`);
    expect(w.logs()).toEqual([]);

    for (const reason of ['', '   ', 'x'.repeat(301)]) {
      const r = await w.post(`/admin/applications/${a}/open`, { reason }, 'adm');
      expect(r.status).toBe(400);
      const h = await r.text();
      expect(h).toContain('열람 사유를 입력해 주십시오');
      for (const s of SECRETS) expect(h).not.toContain(s);
    }
    const nofile = await w.post(`/admin/applications/${a}/file`, { reason: '' }, 'adm');
    expect(nofile.status).toBe(400);
    expect(w.logs()).toEqual([]);

    const open = await w.post(`/admin/applications/${a}/open`, { reason: '신고 #12 확인' }, 'adm');
    expect(open.status).toBe(200);
    expect(open.headers.get('cache-control')).toBe('private, no-store');
    const oh = await open.text();
    for (const s of [NAME, EMAIL, EDITED]) expect(oh).toContain(s);
    expect(oh).toContain(`action="/admin/applications/${a}/file"`);
    expect(w.logs()).toEqual([{ actor_id: 'adm', actor_role: 'admin', target_type: 'application', target_id: a, reason: '신고 #12 확인' }]);
    expect(w.events().filter((e) => e.event === 'viewed')).toEqual([]);
    expect(w.statusOf(a)).toBe('submitted');

    const file = await w.post(`/admin/applications/${a}/file`, { reason: '신고 #12 확인' }, 'adm');
    expect(file.status).toBe(200);
    expect(await bytes(file)).toEqual(pdf);
    expect(w.logs()).toHaveLength(2);
    expect(w.logs()[1]!.reason).toBe('신고 #12 확인');
    expect(w.statusOf(a)).toBe('submitted');

    // 구직자는 운영자 열람을 역할로 본다 (사유는 보이지 않는다)
    const mine = await (await w.get(`/my/applications/${a}`, 's1')).text();
    expect(mine).toContain('<td>운영자</td>');
    expect(mine).not.toContain('신고 #12');

    // GET 으로 내용 주소에 닿을 수 없다
    expect((await w.get(`/admin/applications/${a}/open`, 'adm')).status).toBe(404);
    expect((await w.req('HEAD', `/admin/applications/${a}`, 'adm')).status).toBe(405);
  });

  it('관리자: 취소된 지원은 안내만, 기록 없음', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    expect((await w.post(`/my/applications/${a}/withdraw`, {}, 's1')).status).toBe(302);
    expect(await (await w.get(`/admin/applications/${a}`, 'adm')).text()).toContain('구직자가 취소한 지원입니다');
    const r = await w.post(`/admin/applications/${a}/open`, { reason: '확인' }, 'adm');
    expect(await r.text()).toContain('구직자가 취소한 지원입니다');
    expect(w.logs()).toEqual([]);
  });

  it('기업·구직자는 /admin 에 닿지 않는다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    for (const who of ['co', 's1'] as const) {
      expect((await w.get('/admin/access-log', who)).status).toBe(403);
      expect((await w.get(`/admin/applications/${a}`, who)).status).toBe(403);
      expect((await w.post(`/admin/applications/${a}/open`, { reason: 'x' }, who)).status).toBe(403);
      expect((await w.post(`/admin/applications/${a}/file`, { reason: 'x' }, who)).status).toBe(403);
    }
    expect(w.logs()).toEqual([]);
  });

  it('열람 기록 화면: 줄·필터·커서, 잘못된 필터는 무시, 같은 초가 페이지 경계에 걸려도 빠지지 않는다', async () => {
    const w = world();
    const a = await applyAs(w, 's1', { name: NAME, email: EMAIL, consent: false, withFile: true });
    await w.get(`/biz/applications/${a}`);
    await w.post(`/admin/applications/${a}/open`, { reason: '사유-가' }, 'adm');
    const page = await w.get('/admin/access-log', 'adm');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    const h = await page.text();
    expect(h).toContain('co@example.test');
    expect(h).toContain('adm@example.test');
    expect(h).toContain('사유-가');
    expect(h).toContain(`href="/admin/applications/${a}"`);
    for (const s of [NAME, EMAIL, EDITED]) expect(h).not.toContain(s);

    // 직접 넣은 기록: 시각 1000..1069 에 하나씩 70줄, 그중 1015 에는 5줄 더 (verification_doc)
    const ins = w.raw.prepare('INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 70; i++) ins.run(`r-${String(i).padStart(3, '0')}`, 'adm', 'admin', 'resume', `res-${i}`, null, 1000 + i);
    for (let i = 0; i < 5; i++) ins.run(`d-${i}`, 'co', 'company', 'verification_doc', `doc-${i}`, null, 1015);

    const ids = (html: string) => [...html.matchAll(/>(res-\d+|doc-\d)</g)].map((m) => m[1]!);
    const p1 = await (await w.get('/admin/access-log?type=resume', 'adm')).text();
    const got1 = ids(p1);
    expect(got1).toHaveLength(50);
    expect(got1[0]).toBe('res-69');
    const next = /href="\/admin\/access-log\?type=resume&amp;before=(\d+)"/.exec(p1)![1]!;
    const p2 = await (await w.get(`/admin/access-log?type=resume&before=${next}`, 'adm')).text();
    const got2 = ids(p2);
    expect([...got1, ...got2].sort()).toEqual(Array.from({ length: 70 }, (_, i) => `res-${i}`).sort());
    expect(p2).not.toContain('before=');

    // 전체 보기: 75 + 실제 2줄. 1015 의 6줄이 페이지 경계에 걸려도 모두 나온다
    const all: string[] = [];
    let path = '/admin/access-log';
    for (let n = 0; n < 5 && path; n++) {
      const html = await (await w.get(path, 'adm')).text();
      all.push(...ids(html));
      const m = /href="(\/admin\/access-log\?before=\d+)"/.exec(html);
      path = m ? m[1]! : '';
    }
    expect(all.sort()).toEqual([...Array.from({ length: 70 }, (_, i) => `res-${i}`), ...Array.from({ length: 5 }, (_, i) => `doc-${i}`)].sort());

    // 잘못된 필터·커서는 무시된다 (전체, 첫 페이지)
    const bad = await (await w.get('/admin/access-log?type=users&before=abc', 'adm')).text();
    expect(ids(bad)).toEqual(ids(await (await w.get('/admin/access-log', 'adm')).text()));
    const docs = ids(await (await w.get('/admin/access-log?type=verification_doc', 'adm')).text());
    expect(docs.sort()).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
    // 관리자 첫 화면에서 연결 (첫 화면 라우트는 읽기 batch 를 써서 이 테스트용 어댑터로는 돌지 않는다 → 화면 조각만 확인)
    expect(String(await AdminHome({ locale: 'ko', counts: { companies: 0, agencies: 0, jobReviews: 0, reports: 0 } }))).toContain('href="/admin/access-log"');
  });
});
