// 남용 방지 한도 (T-05c) — app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB + 가짜 R2 + Resend 를 잡는 fetch + Workers AI 바인딩 흉내(번역 엔진).
// 한도는 변수로 작게 바꿔 시험한다 (LOCALIZE_PER_COMPANY_DAY 등). 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { kstDay, SCOPES, SITE } from '../src/lib/quota';
import { now } from '../src/env';
import { agreeRequired } from './consent-fixture';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';

const J1 = '11111111-1111-4111-8111-111111111111'; // c1 게재 중 공고 (지원 받는 곳)
const ENGINE_OUT = JSON.stringify({ title_ko: '가짜 영업 매니저', body_ko: '가짜 영업 담당 본문', title_zh: '假销售经理', body_zh: '假负责销售', ko: '가짜 면접 안내 번역' });
const MSG = '您好，请于11月25日14:00来面试。';

type Who = 's1' | 's2' | 's3' | 'co' | 'co2' | 'adm';

function world(o: { engine?: boolean; vars?: Record<string, string> } = {}) {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0), ('s3','s3@example.test','seeker','active',0),
    ('co','co@example.test','company','active',0), ('co2','co2@example.test','company','active',0), ('adm','adm@example.test','admin','active',0)`);
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES
    ('c1','가짜전자','kr_entity','verified',0), ('c2','다른가짜','kr_entity','verified',0)`);
  raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','co','owner',0,0), ('c2','co2','owner',0,0)`);
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_zh, title_ko, body_ko, contact_email, localize_status, status, published_at, created_at, updated_at, company_name_public) VALUES
    ('${J1}','c1','co','office','假销售经理','가짜 영업 매니저','본문','hr@example-corp.test','approved','published',1,0,0,1)`);
  const store = new Map<string, Uint8Array>();
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v.slice() : new Uint8Array(v)); },
    get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(0), body: v } : null; },
    delete: async (k: string) => { store.delete(k); },
  };
  const engineCalls: string[] = [];
  const AI = o.engine ? { run: async (_m: string, input: unknown) => { engineCalls.push(JSON.stringify(input)); return { response: ENGINE_OUT }; } } : undefined;
  const env: Record<string, unknown> = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    RESEND_API_KEY: 'test-key', MAIL_FROM: 'Recruit <no-reply@x.test>',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
    ...(AI ? { AI } : {}), ...(o.vars ?? {}),
  };
  const mails: Array<{ to: string[]; subject: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => {
    expect(String(u)).toBe('https://api.resend.com/emails');
    mails.push(JSON.parse(String(init!.body)));
    return new Response('{}', { status: 200 });
  }));
  const sessions = new Map<Who, string>();
  const cookie = async (who: Who | null, lang: string): Promise<Record<string, string>> => {
    if (!who) return { cookie: `lang=${lang}` };
    if (!sessions.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      agreeRequired(raw, who);
      sessions.set(who, token);
    }
    return { cookie: `sid=${sessions.get(who)}; lang=${lang}` };
  };
  const get = async (path: string, who: Who | null = 'co', lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who, lang) }) as never, env as never);
  const post = async (path: string, form: FormData | Record<string, string> | Array<[string, string]> = {}, who: Who | null = 'co', lang = 'ko') => {
    const body = form instanceof FormData ? form : new URLSearchParams(form);
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { ...(await cookie(who, lang)), origin: ORIGIN } }) as never, env as never);
  };
  const rows = (sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[])).map((r) => ({ ...r }));
  const one = (sql: string, ...a: unknown[]) => rows(sql, ...a)[0];
  const usage = (scope: string, subject: string, day = kstDay(now())) =>
    Number(one('SELECT n FROM usage_counters WHERE scope = ? AND subject = ? AND day = ?', scope, subject, day)?.n ?? 0);
  const setUsage = (scope: string, subject: string, n: number, day = kstDay(now())) =>
    raw.prepare('INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES (?,?,?,?,0) ON CONFLICT (scope, subject, day) DO UPDATE SET n = excluded.n').run(scope, subject, day, n);
  /** 원문만 있는 초안 공고. */
  const draft = (company = 'c1', by = 'co', status = 'draft') => {
    const id = crypto.randomUUID();
    raw.prepare(`INSERT INTO jobs (id, company_id, created_by, job_family, title_zh, source_zh, localize_status, status, created_at, updated_at, rev)
      VALUES (?,?,?,'office','假销售经理','负责销售','draft',?,0,0,0)`).run(id, company, by, status);
    return id;
  };
  const rev = (id: string) => String(one('SELECT rev FROM jobs WHERE id = ?', id)!.rev);
  /** 같은 공고 20초 간격 제한을 비운다 (한도만 시험하기 위해). */
  const unclaim = (id: string) => raw.prepare('UPDATE jobs SET localize_requested_at = NULL WHERE id = ?').run(id);
  return { raw, env, get, post, rows, one, usage, setUsage, draft, rev, unclaim, mails, engineCalls };
}
type World = ReturnType<typeof world>;

async function applyAs(w: World, who: 's1' | 's2' | 's3') {
  const fd = new FormData();
  const fields = { title: '영업직용', name: `가짜${who}`, chinese_level: 'business', years: '5', headline: '가짜한줄소개', contact_email: `${who}.contact@example.test`, experience_text: '경력 요약 가짜' };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('attachment', new File([], '', { type: 'application/octet-stream' }));
  expect((await w.post('/my/resumes/new', fd, who)).status).toBe(302);
  const resumeId = String(w.raw.prepare('SELECT id FROM resumes WHERE user_id = ?').get(who)!.id);
  const { title: _t, ...rest } = fields;
  const res = await w.post(`/jobs/${J1}/apply`, { resume_id: resumeId, ...rest }, who);
  expect(res.status).toBe(302);
  return /\/my\/applications\/([0-9a-f-]{36})\?ok=/.exec(res.headers.get('location') ?? '')![1]!;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe.skipIf(!hasSqlite)('남용 방지 한도 (T-05c)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  // ── 공고 현지화

  it('기업 몫을 다 쓰면 엔진을 부르지 않고 안내, 한국어 직접 입력은 그대로 된다', async () => {
    const w = world({ engine: true, vars: { LOCALIZE_PER_COMPANY_DAY: '2' } });
    const j = w.draft();
    for (let i = 0; i < 2; i++) {
      w.unclaim(j);
      const r = await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j), ...(i ? { again: '1' } : {}) });
      expect(r.status).toBe(302);
    }
    expect(w.engineCalls.length).toBe(4); // 초안 + 대조본 × 2
    w.unclaim(j);
    const r = await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j), again: '1' });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('오늘 자동 번역 한도(2회)를 모두 썼습니다. 내일 다시 시도하거나 한국어를 직접 입력해 주세요.');
    expect(html).toContain(`action="/biz/jobs/${j}/korean"`);
    expect(w.engineCalls.length).toBe(4);
    expect(w.usage(SCOPES.localizeCompany, 'c1')).toBe(2);
    expect(w.usage(SCOPES.localizeSite, SITE)).toBe(2);
    // 수동 입력은 막히지 않는다
    const k = await w.post(`/biz/jobs/${j}/korean`, { rev: w.rev(j), title_ko: '직접 쓴 제목', body_ko: '직접 쓴 본문' });
    expect(k.status).toBe(302);
    expect(w.one('SELECT title_ko FROM jobs WHERE id = ?', j)!.title_ko).toBe('직접 쓴 제목');
    // 중국어 화면은 중국어 안내
    w.unclaim(j);
    const zh = await (await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j), again: '1' }, 'co', 'zh')).text();
    expect(zh).toContain('今天的自动翻译次数（2次）已用完。请明天再试，或直接填写韩文。');
  });

  it('사이트 몫을 다 쓰면 다른 기업도 막힌다', async () => {
    const w = world({ engine: true, vars: { LOCALIZE_SITE_DAY: '1' } });
    const a = w.draft('c1', 'co'), b = w.draft('c2', 'co2');
    expect((await w.post(`/biz/jobs/${a}/localize`, { rev: w.rev(a) })).status).toBe(302);
    const r = await w.post(`/biz/jobs/${b}/localize`, { rev: w.rev(b) }, 'co2');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('사이트 전체의 자동 번역 한도에 도달해');
    expect(w.engineCalls.length).toBe(2);
    // 기업 몫은 사이트 몫보다 먼저 잡혀 하나 쓴 것으로 남는다 (설계대로)
    expect(w.usage(SCOPES.localizeCompany, 'c2')).toBe(1);
    expect(w.usage(SCOPES.localizeSite, SITE)).toBe(1);
  });

  it('엔진이 없으면 한도를 쓰지 않는다 (no_engine 이 먼저)', async () => {
    const w = world({ engine: false, vars: { LOCALIZE_PER_COMPANY_DAY: '1' } });
    const j = w.draft();
    const r = await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j) });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('자동으로 만들 수 없습니다');
    expect(w.rows('SELECT * FROM usage_counters')).toEqual([]);
  });

  it('한국 시간으로 날짜가 바뀌면 다시 쓸 수 있다 (어제 행은 오늘에 영향 없음)', async () => {
    const w = world({ engine: true, vars: { LOCALIZE_PER_COMPANY_DAY: '1' } });
    w.setUsage(SCOPES.localizeCompany, 'c1', 1, kstDay(now() - 86400));
    const j = w.draft();
    expect((await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j) })).status).toBe(302);
    expect(w.usage(SCOPES.localizeCompany, 'c1')).toBe(1);
  });

  // ── 면접 요청: 번역 미리 보기 · 보내기

  it('미리 보기: 번역 한도를 넘으면 엔진 없이 원문만 + 안내, 보내기는 된다', async () => {
    const w = world({ engine: true, vars: { LOCALIZE_PER_COMPANY_DAY: '1' } });
    const a = await applyAs(w, 's1');
    w.mails.length = 0;
    // 첫 미리 보기는 번역된다 (기업 몫 1)
    const p1 = await (await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG })).text();
    expect(p1).toContain('가짜 면접 안내 번역');
    expect(w.engineCalls.length).toBe(1);
    // 같은 몫을 공고 현지화와 같이 쓴다 → 두 번째는 한도
    const r = await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(w.engineCalls.length).toBe(1);
    expect(html).toContain(esc(MSG));
    expect(html).toContain('오늘 자동 번역 한도(1회)를 모두 써서 번역하지 않았습니다. 원문만 보냅니다.');
    expect(html).not.toContain('name="translation"');
    // 보내기는 번역 한도와 상관없다
    const s = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
    expect(s.status).toBe(303);
    expect(w.mails.length).toBe(1);
    // 공고 현지화도 같은 몫이라 막힌다
    const j = w.draft();
    expect((await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j) })).status).toBe(400);
  });

  it('보내기: 메일 한도를 넘으면 Resend 를 부르지 않고, 이벤트·상태 변화 없음, 글은 미리 보기에 남는다', async () => {
    const w = world({ vars: { MAIL_PER_COMPANY_DAY: '3' } });
    const a = await applyAs(w, 's1');
    w.mails.length = 0;
    w.setUsage(SCOPES.mailCompany, 'c1', 3);
    const before = w.one('SELECT status FROM applications WHERE id = ?', a)!.status;
    const r = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('오늘 이 기업의 메일 발송 한도(3통)를 모두 써서 보내지 않았습니다.');
    expect(html).toContain(esc(MSG));
    expect(w.mails.length).toBe(0);
    expect(w.rows("SELECT * FROM application_events WHERE event = 'interview_mail'")).toEqual([]);
    expect(w.one('SELECT status FROM applications WHERE id = ?', a)!.status).toBe(before);
    expect(w.usage(SCOPES.mailCompany, 'c1')).toBe(3);
    expect(w.usage(SCOPES.mailSite, SITE)).toBe(0);
  });

  it('불합격 통보 묶음: 한도에서 멈추고 보낸 수·한도로 못 보낸 수를 알린다 (보낸 것만 불합격)', async () => {
    const w = world({ vars: { MAIL_PER_COMPANY_DAY: '2' } });
    const ids = [await applyAs(w, 's1'), await applyAs(w, 's2'), await applyAs(w, 's3')];
    w.mails.length = 0;
    const r = await w.post(`/biz/jobs/${J1}/applicants/reject/send`, ids.map((id) => ['id', id] as [string, string]));
    expect(r.status).toBe(303);
    const loc = r.headers.get('location')!;
    expect(loc).toBe(`/biz/jobs/${J1}/applicants?ok=rejected&sent=2&failed=0&limited=1&pool=company`);
    expect(w.mails.length).toBe(2);
    const st = w.rows('SELECT status FROM applications ORDER BY created_at, rowid').map((x) => x.status);
    expect(st.filter((s) => s === 'rejected').length).toBe(2);
    expect(w.rows("SELECT * FROM application_events WHERE event = 'reject_mail'").length).toBe(2);
    const list = await (await w.get(loc)).text();
    expect(list).toContain('2명에게 불합격 통보를 보냈습니다.');
    expect(list).toContain('1건은 메일 발송 한도에 걸려 보내지 않았습니다');
    expect(list).toContain('메일 발송 한도(2통)');
    const zh = await (await w.get(loc, 'co', 'zh')).text();
    expect(zh).toContain('有 1 份因邮件发送上限未发送');
  });

  it('사이트 메일 몫: 다른 기업이 다 쓰면 이 기업도 못 보낸다', async () => {
    const w = world({ vars: { MAIL_SITE_DAY: '5' } });
    const a = await applyAs(w, 's1');
    w.mails.length = 0;
    w.setUsage(SCOPES.mailSite, SITE, 5);
    const r = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('사이트 전체의 메일 발송 한도에 도달해 보내지 않았습니다');
    expect(w.mails.length).toBe(0);
  });

  // ── 담당자 초대

  it('초대: 메일 한도를 넘으면 초대는 저장되고 메일은 보내지 않는다 (직접 알리라는 안내)', async () => {
    const w = world({ vars: { MAIL_PER_COMPANY_DAY: '1' } });
    expect((await w.post('/biz/members/invite', { email: 'new1@example.test' })).headers.get('location')).toBe('/biz/members?ok=invited');
    expect(w.mails.length).toBe(1);
    const r = await w.post('/biz/members/invite', { email: 'new2@example.test' });
    expect(r.headers.get('location')).toBe('/biz/members?ok=invited&mail=limit_company');
    expect(w.mails.length).toBe(1);
    expect(w.rows("SELECT email FROM company_invites WHERE company_id = 'c1' ORDER BY email").map((x) => x.email)).toEqual(['new1@example.test', 'new2@example.test']);
    const html = await (await w.get('/biz/members?ok=invited&mail=limit_company')).text();
    expect(html).toContain('초대는 저장했습니다. 오늘 이 기업의 메일 발송 한도(1통)를 모두 써서 안내 메일은 보내지 않았으니');
    const zh = await (await w.get('/biz/members?ok=invited&mail=limit_company', 'co', 'zh')).text();
    expect(zh).toContain('今天本企业的邮件发送上限（1封）已用完');
  });

  it('초대: 검증 전 기업은 메일을 보내지 않으므로 한도도 쓰지 않는다', async () => {
    const w = world({ vars: { MAIL_PER_COMPANY_DAY: '0' } });
    w.raw.exec("UPDATE companies SET verify_status = 'pending' WHERE id = 'c1'");
    const r = await w.post('/biz/members/invite', { email: 'new1@example.test' });
    expect(r.headers.get('location')).toBe('/biz/members?ok=invited&mail=skipped');
    expect(w.rows('SELECT * FROM usage_counters')).toEqual([]);
  });

  // ── 초안 개수

  it('작성 중인 공고 한도: 넘으면 거절(입력 유지), 게재·마감된 공고는 세지 않는다, 기존 초안은 고칠 수 있다', async () => {
    const w = world({ vars: { DRAFT_JOBS_PER_COMPANY: '2' } });
    const form = { title_zh: '新职位标题', source_zh: '新职位正文', job_family: 'office' };
    expect((await w.post('/biz/jobs/new', form)).status).toBe(302);
    expect((await w.post('/biz/jobs/new', form)).status).toBe(302);
    const r = await w.post('/biz/jobs/new', form);
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('작성 중인 공고(게재 중·마감이 아닌 공고)가 2개로 한도에 도달해 새 공고를 만들 수 없습니다.');
    expect(html).toContain('新职位标题');
    const mine = () => w.rows("SELECT id, status FROM jobs WHERE company_id = 'c1' AND id != ?", J1);
    expect(mine().length).toBe(2);
    // 차단된 공고도 센다
    w.raw.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(mine()[0]!.id);
    expect((await w.post('/biz/jobs/new', form)).status).toBe(400);
    // 하나를 게재(또는 마감)하면 다시 만들 수 있다
    w.raw.prepare("UPDATE jobs SET status = 'published' WHERE id = ?").run(mine()[0]!.id);
    expect((await w.post('/biz/jobs/new', form)).status).toBe(302);
    expect((await w.post('/biz/jobs/new', form)).status).toBe(400);
    const d = mine().find((x) => x.status === 'draft')!.id as string;
    w.raw.prepare("UPDATE jobs SET status = 'closed' WHERE id = ?").run(d);
    expect((await w.post('/biz/jobs/new', form)).status).toBe(302);
    // 다른 기업은 따로 센다
    expect((await w.post('/biz/jobs/new', form, 'co2')).status).toBe(302);
    // 기존 초안 편집은 한도와 상관없다
    const e = mine().find((x) => x.status === 'draft')!.id as string;
    expect((await w.post(`/biz/jobs/${e}/edit`, { ...form, title_zh: '改过的标题', rev: w.rev(e) })).status).toBe(302);
    const zh = await (await w.post('/biz/jobs/new', form, 'co', 'zh')).text();
    expect(zh).toContain('编辑中的职位（未发布、未截止的职位）已达 2 个上限');
  });

  // ── 관리자

  it('관리자 엔진 비교: 엔진 수만큼 세고, 넘으면 엔진을 부르지 않는다', async () => {
    const w = world({ engine: true, vars: { ADMIN_LOCALIZE_TEST_DAY: '2' } });
    const form = [['title', '销售经理'], ['body', '负责销售'], ['engines', 'workers_ai']] as Array<[string, string]>;
    expect((await w.post('/admin/localize-test', form, 'adm')).status).toBe(200);
    expect((await w.post('/admin/localize-test', form, 'adm')).status).toBe(200);
    expect(w.engineCalls.length).toBe(4);
    const r = await w.post('/admin/localize-test', form, 'adm');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('오늘 엔진 비교 한도(2회, 고른 엔진 하나마다 1회)를 넘어 실행하지 않았습니다.');
    expect(w.engineCalls.length).toBe(4);
    expect(w.usage(SCOPES.adminTest, 'adm')).toBe(2);
    expect(w.usage(SCOPES.localizeSite, SITE)).toBe(2); // 사이트 번역 몫도 같이 쓴다
  });

  it('관리자 엔진 비교도 사이트 번역 몫에 막힌다', async () => {
    const w = world({ engine: true, vars: { LOCALIZE_SITE_DAY: '3' } });
    w.setUsage(SCOPES.localizeSite, SITE, 3);
    const r = await w.post('/admin/localize-test', [['title', '销售经理'], ['body', '负责销售'], ['engines', 'workers_ai']], 'adm');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('사이트 전체의 자동 번역 한도(3회)에 도달해 실행하지 않았습니다');
    expect(w.engineCalls.length).toBe(0);
  });

  it('관리자 첫 화면: 오늘 사용량 (사이트 번역·기업 메일, 한도와 함께)', async () => {
    const w = world({ vars: { MAIL_SITE_DAY: '800' } });
    w.setUsage(SCOPES.localizeSite, SITE, 7);
    w.setUsage(SCOPES.mailSite, SITE, 12);
    w.setUsage(SCOPES.mailSite, SITE, 99, kstDay(now() - 86400)); // 어제 것은 보이지 않는다
    const html = await (await w.get('/admin', 'adm')).text();
    expect(html).toContain('오늘 사용량');
    expect(html).toContain(kstDay(now()));
    expect(html).toContain('7 / 500');
    expect(html).toContain('12 / 800');
    expect(html).not.toContain('99 / 800');
    const zh = await (await w.get('/admin', 'adm', 'zh')).text();
    expect(zh).toContain('今日用量');
  });

  it('기업 화면에는 한도에 걸리지 않으면 아무것도 보이지 않는다', async () => {
    const w = world({ engine: true });
    const j = w.draft();
    for (const p of ['/biz', '/biz/jobs', `/biz/jobs/${j}`, '/biz/members', '/biz/jobs/new']) {
      const res = await w.get(p);
      expect(res.status, p).toBe(200);
      expect(await res.text(), p).not.toMatch(/한도/);
    }
  });

  it('카운터에는 id 와 사이트 표시만 (이메일·IP 없음)', async () => {
    const w = world({ engine: true, vars: { MAIL_PER_COMPANY_DAY: '50' } });
    const a = await applyAs(w, 's1');
    const j = w.draft();
    await w.post(`/biz/jobs/${j}/localize`, { rev: w.rev(j) });
    await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG });
    await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
    await w.post('/biz/members/invite', { email: 'new1@example.test' });
    await w.post('/admin/localize-test', [['title', '销售经理'], ['body', '负责销售'], ['engines', 'workers_ai']], 'adm');
    const all = w.rows('SELECT scope, subject, day, n FROM usage_counters ORDER BY scope, subject');
    expect(all.map((x) => `${x.scope}:${x.subject}:${x.n}`)).toEqual([
      'admin_localize_test:adm:1', 'localize_company:c1:2', 'localize_site:site:3', 'mail_company:c1:2', 'mail_site:site:2',
    ]);
    for (const r of all) {
      expect(String(r.subject)).not.toContain('@');
      expect(r.day).toBe(kstDay(now()));
    }
  });
});
