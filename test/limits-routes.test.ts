// T-17 화면: 관리자 사이트 설정의 "사용량 한도"·"조건 알림" 두 단계 저장, 기본값으로 되돌리기, 누가·언제, 권한, /admin/system,
// 알림을 끈 동안의 /jobs·/my/alerts·만들기 거절·해지 링크, 비로그인 /jobs 가 그대로인지. app.fetch 로 라우트 전체를 돈다.
// SQLite 메모리 DB + 가짜 데이터만 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, randomToken, sha256Hex } from '../src/lib/crypto';
import { LIMIT_KEYS, parseLimitsLog, parseStoredLimits } from '../src/lib/limits';
import { DEFAULT_LIMITS, kstDay } from '../src/lib/quota';
import { ALERT_RUN_DEFAULT } from '../src/lib/alerts';
import { agreeRequired } from './consent-fixture';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';
const NO_STORE = 'private, no-store';
const J1 = '0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f';

type Who = 's1' | 'owner' | 'adm' | 'adm0';
const EMAILS: Record<Who, string> = { s1: 'fake.lim1@example.test', owner: 'fake.owner@example.test', adm: 'fake.adm@example.test', adm0: 'fake.adm0@example.test' };

function world(vars: Record<string, string> = {}) {
  const { raw, d1 } = migratedDb();
  raw.exec('PRAGMA foreign_keys = ON');
  const roles: Record<Who, string> = { s1: 'seeker', owner: 'company', adm: 'admin', adm0: 'admin' };
  for (const [id, role] of Object.entries(roles)) raw.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?,?,?,'active',0)").run(id, EMAILS[id as Who], role);
  for (const id of ['s1', 'owner']) agreeRequired(raw, id);
  raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0)");
  raw.exec("INSERT INTO company_members (company_id, user_id, member_role, created_at) VALUES ('c1','owner','owner',0)");
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, location, chinese_level, created_at, updated_at)
    VALUES ('${J1}','c1','owner','office','가짜 영업','본문','approved','published',1,'seoul','business',0,0)`);
  const sqls: string[] = [];
  const db = { prepare: (sql: string) => { sqls.push(sql); return d1.prepare(sql); }, batch: (s: never) => d1.batch(s) } as unknown as D1Database;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES: {}, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '', MAIL_FROM: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off', ...vars,
  } as never;
  const tokens = new Map<string, string>();
  const login = async (who: Who) => {
    if (!tokens.has(who)) {
      const token = `tok-${who}`;
      // adm0 = 관리자인데 TOTP 를 통과하지 않은 세션 (mfa = 0) → 로그인하지 않은 것으로 본다
      raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      tokens.set(who, token);
    }
    return tokens.get(who)!;
  };
  const headers = async (who: Who | null, lang = 'ko', extra: Record<string, string> = {}) =>
    ({ ...(who ? { cookie: `sid=${await login(who)}; lang=${lang}` } : { cookie: `lang=${lang}` }), ...extra });
  const get = async (path: string, who: Who | null = 'adm', lang = 'ko') => app.fetch(new Request(`${ORIGIN}${path}`, { headers: await headers(who, lang) }) as never, env);
  const post = async (path: string, form: Record<string, string> = {}, who: Who | null = 'adm') =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST', body: new URLSearchParams(form),
      headers: await headers(who, 'ko', { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }),
    }) as never, env);
  const one = (sql: string, ...a: unknown[]) => { const r = raw.prepare(sql).get(...(a as never[])); return r ? { ...r } : undefined; };
  const setting = (key: string) => one('SELECT value, updated_by, updated_at FROM site_settings WHERE key = ?', key) as { value: string; updated_by: string; updated_at: number } | undefined;
  return { raw, env, sqls, get, post, one, setting };
}
type World = ReturnType<typeof world>;

const FORM: Record<string, string> = Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(k === 'ALERT_SEND_PER_RUN' ? ALERT_RUN_DEFAULT : DEFAULT_LIMITS[k])]));

const hiddenOf = (html: string) =>
  Object.fromEntries([...html.matchAll(/<input type="hidden" name="([A-Za-z_]+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replaceAll('&quot;', '"')]));

/** 1단계 → 확인 화면의 숨은 칸으로 2단계 (브라우저와 같게). */
async function save(w: World, kind: 'limits' | 'alerts', form: Record<string, string>, o: { confirm?: boolean } = {}) {
  const step1 = await w.post(`/admin/settings/${kind}`, form);
  const html = await step1.text();
  expect(step1.status, html.slice(0, 200)).toBe(200);
  const hidden = hiddenOf(html);
  const res = await w.post(`/admin/settings/${kind}/confirm`, { ...hidden, ...(o.confirm === false ? {} : { confirm: '1' }) });
  return { html, hidden, res };
}
const alertsOff = (w: World) => save(w, 'alerts', { mode: 'save', enabled: '0' });
const alertsOn = (w: World) => save(w, 'alerts', { mode: 'save', enabled: '1' });

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})); });
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe.skipIf(!hasSqlite)('관리자 사용량 한도·조건 알림 설정: 권한·no-store', () => {
  it('구직자·기업은 403, 비로그인·TOTP 안 거친 관리자는 로그인으로 — 모두 no-store, 저장 없음', async () => {
    const w = world();
    const paths: Array<[string, 'get' | 'post']> = [
      ['/admin/settings', 'get'], ['/admin/settings/limits', 'post'], ['/admin/settings/limits/confirm', 'post'],
      ['/admin/settings/alerts', 'post'], ['/admin/settings/alerts/confirm', 'post'], ['/admin/system', 'get'],
    ];
    const form = { ...FORM, mode: 'save', enabled: '0', confirm: '1', base: '{"values":{}}' };
    for (const [path, m] of paths) {
      for (const who of ['s1', 'owner', null, 'adm0'] as const) {
        const res = m === 'get' ? await w.get(path, who) : await w.post(path, form, who);
        expect(res.status, `${path} ${who}`).toBe(who === 's1' || who === 'owner' ? 403 : 302);
        expect(res.headers.get('cache-control'), `${path} ${who}`).toBe(NO_STORE);
      }
    }
    expect(w.setting('limits')).toBeUndefined();
  });

  it('설정 화면·확인 화면은 no-store', async () => {
    const w = world();
    expect((await w.get('/admin/settings')).headers.get('cache-control')).toBe(NO_STORE);
    const step1 = await w.post('/admin/settings/limits', { ...FORM, mode: 'save', MAIL_SITE_DAY: '60' });
    expect(step1.headers.get('cache-control')).toBe(NO_STORE);
    const al = await w.post('/admin/settings/alerts', { mode: 'save', enabled: '0' });
    expect(al.headers.get('cache-control')).toBe(NO_STORE);
  });
});

describe.skipIf(!hasSqlite)('사용량 한도 저장', () => {
  it('설정 화면: 지금 값·범위·출처(기본값·설정 파일), 무료 플랜 경고, 바꾼 적 없음', async () => {
    const w = world({ MAIL_SITE_DAY: '60', ALERT_MAIL_SITE_DAY: '30' });
    const html = await (await w.get('/admin/settings')).text();
    expect(html).toContain('action="/admin/settings/limits"');
    expect(html).toContain('name="MAIL_SITE_DAY" value="60" min="0" max="5000"');
    expect(html).toContain('name="ALERT_SEND_PER_RUN" value="8" min="0" max="10"');
    expect(html).toContain('name="DRAFT_JOBS_PER_COMPANY" value="20" min="1" max="100"');
    expect(html).toMatch(/기업 메일 — 사이트 전체 하루[\s\S]*?<span class="badge">설정 파일<\/span> \(기본값 1000회\)/);
    expect(html).toMatch(/자동 번역 — 사이트 전체 하루[\s\S]*?<span class="badge">기본값<\/span>/);
    expect(html).toContain('외부 호출 50개');
    expect(html).toContain('한도·알림 설정은 아직 이 화면에서 바꾼 적이 없습니다.');
    expect(html).toContain('기업 메일 60 + 조건 알림 메일 30 = 하루 90통'); // 60 + 30 = 90 > 70 → 경고(막지 않음)
    expect(html).toContain('보내는 중');
    const w2 = world({ MAIL_SITE_DAY: '40', ALERT_MAIL_SITE_DAY: '30' });
    expect(await (await w2.get('/admin/settings')).text()).not.toContain('Resend 무료 플랜이라면');
    const w3 = world();
    expect(await (await w3.get('/admin/settings')).text()).toContain('Resend 무료 플랜이라면: 기업 메일 1000 + 조건 알림 메일 40 = 하루 1040통');
    const zh = await (await w.get('/admin/settings', 'adm', 'zh')).text();
    expect(zh).toContain('使用量上限');
    expect(zh).toContain('配置文件');
  });

  it('저장은 확인이 필요하다: 1단계는 저장하지 않고 지금 → 바꾼 뒤를 보인다, "확인했습니다" 없이는 400', async () => {
    const w = world({ MAIL_SITE_DAY: '60' });
    const { html, res } = await save(w, 'limits', { ...FORM, MAIL_SITE_DAY: '60', MAIL_PER_COMPANY_DAY: '20', mode: 'save' }, { confirm: false });
    expect(html).toContain('사용량 한도 변경 확인');
    expect(html).toMatch(/기업 메일 — 기업당 하루<\/td><td>100회 <span class="muted">\(기본값\)<\/span><\/td><td><b>20회<\/b> <span class="muted">\(관리자 설정\)<\/span>/);
    expect(html).not.toContain('기업 메일 — 사이트 전체 하루</td>'); // 바뀌지 않은 칸은 표에 없다
    expect(html).toContain('저장하는 즉시 적용됩니다. 다시 배포할 필요가 없습니다.');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('확인했습니다');
    expect(w.setting('limits')).toBeUndefined();
  });

  it('저장: 바꾼 칸만 관리자 값, 누가·언제·기록, 화면에 출처 "관리자 설정" 과 마지막 변경', async () => {
    const w = world({ MAIL_SITE_DAY: '60' });
    const { res } = await save(w, 'limits', { ...FORM, MAIL_SITE_DAY: '60', MAIL_PER_COMPANY_DAY: '20', mode: 'save' });
    expect([res.status, res.headers.get('location')]).toEqual([303, '/admin/settings?ok=limits_saved#limits']);
    const s = w.setting('limits')!;
    expect(parseStoredLimits(s.value)).toEqual({ values: { MAIL_PER_COMPANY_DAY: 20 } });
    expect(s.updated_by).toBe('adm');
    expect(s.updated_at).toBeGreaterThan(1_700_000_000);
    expect(parseLimitsLog(w.setting('limits.log')!.value)).toEqual([{ at: s.updated_at, by: 'adm', changes: [{ key: 'MAIL_PER_COMPANY_DAY', from: 100, to: 20 }] }]);
    const html = await (await w.get('/admin/settings?ok=limits_saved')).text();
    expect(html).toContain('사용량 한도를 저장했습니다.');
    expect(html).toMatch(/기업 메일 — 기업당 하루[\s\S]*?<span class="badge">관리자 설정<\/span> \(기본값 100회\)/);
    expect(html).toContain('한도·알림 설정 마지막 변경: fake.adm@example.test');
    expect(html).toContain('기업 메일 — 기업당 하루 100회 → 20회');
    // 같은 값으로 다시 → 저장할 것 없음
    const again = await w.post('/admin/settings/limits', { ...FORM, MAIL_SITE_DAY: '60', MAIL_PER_COMPANY_DAY: '20', mode: 'save' });
    expect(again.headers.get('location')).toBe('/admin/settings?ok=limits_unchanged#limits');
  });

  it('범위 밖·정수 아님·기업 > 사이트는 400 + 안내, 저장 없음 (확인 단계로 직접 보내도)', async () => {
    const w = world();
    const r1 = await w.post('/admin/settings/limits', { ...FORM, ALERT_SEND_PER_RUN: '11', mode: 'save' });
    expect(r1.status).toBe(400);
    expect(await r1.text()).toContain('0~10 사이로 입력해 주세요.');
    const r2 = await w.post('/admin/settings/limits', { ...FORM, MAIL_SITE_DAY: '50', MAIL_PER_COMPANY_DAY: '60', mode: 'save' });
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('&quot;기업 메일 — 사이트 전체 하루&quot; 보다 클 수 없습니다.');
    const r3 = await w.post('/admin/settings/limits/confirm', { ...FORM, ALERT_MAIL_SITE_DAY: '500', mode: 'save', confirm: '1', base: '{"values":{}}' });
    expect(r3.status).toBe(400);
    const r4 = await w.post('/admin/settings/limits', { ...FORM, DRAFT_JOBS_PER_COMPANY: 'abc', mode: 'save' });
    expect(r4.status).toBe(400);
    expect(w.setting('limits')).toBeUndefined();
  });

  it('확인 화면을 연 뒤 다른 관리자가 바꿨으면 저장하지 않고 다시 확인받는다', async () => {
    const w = world();
    const step1 = await w.post('/admin/settings/limits', { ...FORM, MAIL_SITE_DAY: '60', MAIL_PER_COMPANY_DAY: '60', mode: 'save' });
    expect(step1.status).toBe(200);
    const hidden = hiddenOf(await step1.text());
    w.raw.prepare("INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('limits','{\"values\":{\"MAIL_SITE_DAY\":70}}','adm',1)").run();
    expect(hidden.base).toBe('{"values":{}}');
    const res = await w.post('/admin/settings/limits/confirm', { ...hidden, confirm: '1' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('70회');
    expect(parseStoredLimits(w.setting('limits')!.value).values).toEqual({ MAIL_SITE_DAY: 70 });
  });

  it('오늘 사용량보다 낮추면 확인 화면에 "내일 0시(한국 시간)까지 더 쓸 수 없음" — 오늘 센 수는 그대로', async () => {
    const w = world();
    const day = kstDay(Math.floor(Date.now() / 1000));
    w.raw.prepare("INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('mail_site','site',?,5,0), ('localize_company','c1',?,7,0)").run(day, day);
    const { html, res } = await save(w, 'limits', { ...FORM, MAIL_SITE_DAY: '3', MAIL_PER_COMPANY_DAY: '3', LOCALIZE_PER_COMPANY_DAY: '7', mode: 'save' });
    expect(html).toContain('기업 메일 — 사이트 전체 하루: 오늘(한국 시간) 이미 5회 써서 새 한도 3회에 닿았습니다. 오늘 남은 시간에는 더 쓸 수 없고, 한국 시간 내일 0시에 다시 0부터 셉니다.');
    expect(html).toContain('자동 번역 — 기업당 하루: 오늘 가장 많이 쓴 곳이 이미 7회입니다.');
    expect(html).toContain('이미 센 횟수는 지우거나 되돌리지 않습니다');
    expect(res.status).toBe(303);
    expect(w.one("SELECT n FROM usage_counters WHERE scope = 'mail_site'")).toEqual({ n: 5 });
  });

  it('기본값으로 되돌리기: 확인을 거쳐 한도 칸의 관리자 값만 지운다 (알림 켜기/끄기는 그대로, 기록에 남음)', async () => {
    const w = world({ MAIL_SITE_DAY: '60' });
    await save(w, 'limits', { ...FORM, MAIL_SITE_DAY: '50', MAIL_PER_COMPANY_DAY: '20', mode: 'save' });
    await alertsOff(w);
    // 잘못된 칸이 있어도 되돌리기는 된다 (값을 보지 않는다)
    const { html, res } = await save(w, 'limits', { ...FORM, MAIL_SITE_DAY: 'x', mode: 'reset' });
    expect(html).toContain('이 화면에서 정한 한도를 모두 지웁니다.');
    expect(html).toMatch(/50회 <span class="muted">\(관리자 설정\)<\/span><\/td><td><b>60회<\/b> <span class="muted">\(설정 파일\)<\/span>/);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=limits_reset#limits');
    expect(parseStoredLimits(w.setting('limits')!.value)).toEqual({ values: {}, alerts_enabled: false });
    const log = parseLimitsLog(w.setting('limits.log')!.value);
    expect(log.at(-1)).toMatchObject({ by: 'adm', reset: true });
    // 되돌릴 것이 없으면 저장하지 않는다
    expect((await w.post('/admin/settings/limits', { mode: 'reset' })).headers.get('location')).toBe('/admin/settings?ok=limits_unchanged#limits');
    // 알림도 기본값(켜짐)으로
    const r2 = await save(w, 'alerts', { mode: 'reset' });
    expect(r2.res.headers.get('location')).toBe('/admin/settings?ok=alerts_reset#alerts');
    expect(parseStoredLimits(w.setting('limits')!.value)).toEqual({ values: {} });
  });

  it('저장한 한도는 바로 적용된다: 초안 한도를 1 로 → 두 번째 새 공고 거절, 다시 올리면 허용', async () => {
    const w = world();
    await save(w, 'limits', { ...FORM, DRAFT_JOBS_PER_COMPANY: '2', mode: 'save' });
    const form = { title_zh: '新职位标题', source_zh: '新职位正文', job_family: 'office' };
    expect((await w.post('/biz/jobs/new', form, 'owner')).status).toBe(302);
    expect((await w.post('/biz/jobs/new', form, 'owner')).status).toBe(302);
    const r = await w.post('/biz/jobs/new', form, 'owner');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('2개로 한도에 도달');
    await save(w, 'limits', { ...FORM, DRAFT_JOBS_PER_COMPANY: '3', mode: 'save' });
    expect((await w.post('/biz/jobs/new', form, 'owner')).status).toBe(302);
  });
});

describe.skipIf(!hasSqlite)('/admin/system: 지금 적용되는 값과 출처, 알림 상태', () => {
  it('기본값·설정 파일·관리자 설정이 칸마다 보이고, 알림 끄면 "일시 중단 — 관리자가 껐습니다"', async () => {
    const w = world({ LOCALIZE_SITE_DAY: '200' });
    await save(w, 'limits', { ...FORM, LOCALIZE_SITE_DAY: '200', MAIL_SITE_DAY: '60', MAIL_PER_COMPANY_DAY: '60', mode: 'save' });
    let html = await (await w.get('/admin/system')).text();
    expect(html).toContain('사용량 한도와 조건 알림 (지금 적용되는 값)');
    expect(html).toMatch(/<th>자동 번역 — 사이트 전체 하루<\/th><td class="num">200회<\/td><td>설정 파일<\/td>/);
    expect(html).toMatch(/<th>기업 메일 — 사이트 전체 하루<\/th><td class="num">60회<\/td><td>관리자 설정<\/td>/);
    expect(html).toMatch(/<th>작성 중인 공고 — 기업당 개수<\/th><td class="num">20개<\/td><td>기본값<\/td>/);
    expect(html).toContain('<b>보내는 중</b>');
    expect(html).toContain('0 / 60'); // 오늘 사용량 줄도 지금 값
    await alertsOff(w);
    html = await (await w.get('/admin/system')).text();
    expect(html).toContain('<b>일시 중단</b><span class="muted"> — 관리자가 껐습니다.</span>');
  });
});

describe.skipIf(!hasSqlite)('조건 알림 끄기: 구직자 화면', () => {
  const CREATE = { chinese_level: 'business', location: 'seoul', frequency: 'daily', optin: '1' };

  it('알림 끄기도 확인 화면을 거치고 결과를 쉬운 말로 보인다', async () => {
    const w = world();
    const { html, res } = await alertsOff(w);
    expect(html).toContain('조건 알림 변경 확인');
    expect(html).toContain('켜짐 <span class="muted">(기본값)</span>');
    expect(html).toContain('<b>꺼짐</b> <span class="muted">(관리자 설정)</span>');
    expect(html).toContain('로그인하지 않은 사람이 보는 채용정보 화면은 바뀌지 않습니다.');
    expect(res.headers.get('location')).toBe('/admin/settings?ok=alerts_saved#alerts');
    expect(parseStoredLimits(w.setting('limits')!.value)).toEqual({ values: {}, alerts_enabled: false });
    expect(w.setting('limits')!.updated_by).toBe('adm');
    // 다시 켤 때: 멈춘 동안의 공고도 다음 메일에
    const on = await alertsOn(w);
    expect(on.html).toContain('멈춰 있던 동안 게재된 공고도 다음 메일에 들어갑니다');
  });

  it('끈 동안: /jobs 는 칸 대신 한 줄 안내, /my/alerts 는 안내 + 관리 그대로, 만들기는 거절, 해지 링크는 된다 — 켜면 원래대로', async () => {
    const w = world();
    expect((await w.post('/my/alerts', CREATE, 's1')).status).toBe(303);
    const id = (w.one("SELECT id FROM alerts WHERE seeker_id = 's1'") as { id: string }).id;
    await alertsOff(w);

    const jobs = await (await w.get('/jobs?chinese_level=business&location=seoul', 's1')).text();
    expect(jobs).not.toContain('action="/my/alerts"');
    expect(jobs).toContain('<p class="info">조건 알림 메일 발송이 일시 중단되었습니다. 지금은 새 알림을 만들 수 없습니다. <a href="/my/alerts">');

    const list = await w.get('/my/alerts', 's1');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe(NO_STORE);
    const lh = await list.text();
    expect(lh).toContain('<p class="warn">조건 알림 메일 발송이 일시 중단되었습니다.');
    expect(lh).toContain(`action="/my/alerts/${id}/pause"`);

    const created = await w.post('/my/alerts', { ...CREATE, location: 'busan' }, 's1');
    expect(created.status).toBe(400);
    expect(await created.text()).toContain('조건 알림 메일 발송이 일시 중단되어 지금은 새 알림을 만들 수 없습니다.');
    expect(w.one("SELECT COUNT(*) AS n FROM alerts WHERE seeker_id = 's1'")).toEqual({ n: 1 });

    // 관리(끄기·빈도·다시 켜기·삭제)는 된다
    expect((await w.post(`/my/alerts/${id}/pause`, {}, 's1')).headers.get('location')).toBe('/my/alerts?ok=paused');
    expect((await w.post(`/my/alerts/${id}/resume`, { optin: '1' }, 's1')).headers.get('location')).toBe('/my/alerts?ok=resumed');
    expect((await w.post(`/my/alerts/${id}/frequency`, { frequency: 'weekly' }, 's1')).headers.get('location')).toBe('/my/alerts?ok=saved');

    // 해지 링크 (로그인 없이, 한 번 클릭 포함)
    const t = randomToken(32);
    w.raw.prepare('INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) VALUES (?,?,0)').run(await sha256Hex(t), id);
    expect((await w.get(`/alerts/u/${t}`, null)).status).toBe(200);
    const oneClick = await app.fetch(new Request(`${ORIGIN}/alerts/u/${t}`, {
      method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, w.env);
    expect(oneClick.status).toBe(200);
    expect(w.one('SELECT status, paused_reason FROM alerts WHERE id = ?', id)).toEqual({ status: 'paused', paused_reason: 'unsubscribe' });
    expect((await w.post(`/my/alerts/${id}/delete`, {}, 's1')).headers.get('location')).toBe('/my/alerts?ok=deleted');

    await alertsOn(w);
    const back = await (await w.get('/jobs?chinese_level=business&location=seoul', 's1')).text();
    expect(back).toContain('action="/my/alerts"');
    expect(back).not.toContain('일시 중단');
    expect(await (await w.get('/my/alerts', 's1')).text()).not.toContain('일시 중단');
    expect((await w.post('/my/alerts', CREATE, 's1')).status).toBe(303);
  });

  it('ALERT_MAIL_SITE_DAY = 0 (관리자 설정·설정 파일) 도 같은 "일시 중단" 상태', async () => {
    const w = world();
    await save(w, 'limits', { ...FORM, ALERT_MAIL_SITE_DAY: '0', mode: 'save' });
    const step = await (await w.post('/admin/settings/limits', { ...FORM, ALERT_MAIL_SITE_DAY: '0', ALERT_SEND_PER_RUN: '0', mode: 'save' })).text();
    expect(step).toContain('0: 조건 알림 메일 발송이 멈춥니다');
    for (const ww of [w, world({ ALERT_MAIL_SITE_DAY: '0' })]) {
      expect(await (await ww.get('/jobs?location=seoul', 's1')).text()).toContain('조건 알림 메일 발송이 일시 중단되었습니다.');
      expect(await (await ww.get('/my/alerts', 's1')).text()).toContain('조건 알림 메일 발송이 일시 중단되었습니다.');
      expect((await ww.post('/my/alerts', CREATE, 's1')).status).toBe(400);
      expect(await (await ww.get('/admin/settings')).text()).toContain('&quot;조건 알림 메일 — 사이트 전체 하루&quot; 한도가 0 입니다.');
    }
    // 알림을 켜도(이미 켜짐) 한도가 0 이면 확인 화면에서 알린다
    const off = await alertsOff(w);
    expect(off.res.status).toBe(303);
    const on = await w.post('/admin/settings/alerts', { mode: 'save', enabled: '1' });
    expect(await on.text()).toContain('켜도 &quot;조건 알림 메일 — 사이트 전체 하루&quot; 한도가 0 이라 발송은 계속 멈춰 있습니다.');
  });

  it('비로그인 /jobs HTML 은 알림 켜짐·꺼짐과 관계없이 바이트까지 같고, 한도 설정을 읽지 않는다', async () => {
    const w = world();
    const paths = ['/jobs', '/jobs?location=seoul', '/jobs?chinese_level=business&location=seoul'];
    const before = await Promise.all(paths.map(async (p) => (await w.get(p, null)).text()));
    await alertsOff(w);
    w.sqls.length = 0;
    const after = await Promise.all(paths.map(async (p) => (await w.get(p, null)).text()));
    expect(after).toEqual(before);
    // 요청마다 site_settings 는 보일 필터 한 행만 (T-17 전과 같음 — 한도 설정을 더 읽지 않는다)
    expect(w.sqls.filter((s) => s.includes('site_settings')).length).toBe(paths.length);
    // 기업·관리자에게도 칸·안내 없음 (읽지도 않음)
    const co = await (await w.get('/jobs?location=seoul', 'owner')).text();
    expect(co).not.toContain('일시 중단');
    expect(co).not.toContain('action="/my/alerts"');
  });
});
