// T-10 조건 알림 화면: /jobs 의 만들기 칸, /my/alerts, 해지 링크 /alerts/u/:token, 출처 검사 예외, 관리자 개수. app.fetch 로 라우트 전체를 돈다.
// SQLite 메모리 DB + 가짜 데이터만 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, randomToken, sha256Hex } from '../src/lib/crypto';
import { ALERT_MAX_PER_USER, ALERT_OPTIN_VERSION } from '../src/lib/alerts';
import { agreeRequired } from './consent-fixture';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';
const NO_STORE = 'private, no-store';
const J1 = '0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f';

type Who = 's1' | 's2' | 'owner' | 'adm' | 'late';
const EMAILS: Record<Who, string> = {
  s1: 'fake.alert1@example.test', s2: 'fake.alert2@example.test', owner: 'fake.owner@example.test', adm: 'fake.adm@example.test', late: 'fake.late@example.test',
};

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec('PRAGMA foreign_keys = ON');
  const roles: Record<Who, string> = { s1: 'seeker', s2: 'seeker', owner: 'company', adm: 'admin', late: 'seeker' };
  for (const [id, role] of Object.entries(roles)) raw.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?,?,?,'active',0)").run(id, EMAILS[id as Who], role);
  for (const id of ['s1', 's2', 'owner']) agreeRequired(raw, id); // 'late' 는 동의 전
  raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0)");
  raw.exec("INSERT INTO company_members (company_id, user_id, member_role, created_at) VALUES ('c1','owner','owner',0)");
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, location, chinese_level, created_at, updated_at)
    VALUES ('${J1}','c1','owner','office','가짜 영업','본문','approved','published',1,'seoul','business',0,0)`);
  const sqls: string[] = [];
  const db = { prepare: (sql: string) => { sqls.push(sql); return d1.prepare(sql); }, batch: (s: never) => d1.batch(s) } as unknown as D1Database;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES: {}, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '', MAIL_FROM: '',
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
  const headers = async (who: Who | null, extra: Record<string, string> = {}) => ({ ...(who ? { cookie: `sid=${await login(who)}; lang=ko` } : { cookie: 'lang=ko' }), ...extra });
  const get = async (path: string, who: Who | null = 's1') => app.fetch(new Request(`${ORIGIN}${path}`, { headers: await headers(who) }) as never, env);
  const post = async (path: string, form: Record<string, string> = {}, who: Who | null = 's1', o: { origin?: string | null; body?: string } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST', body: o.body ?? new URLSearchParams(form),
      headers: await headers(who, { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), 'content-type': 'application/x-www-form-urlencoded' }),
    }) as never, env);
  const alerts = (who: string) => raw.prepare('SELECT * FROM alerts WHERE seeker_id = ? ORDER BY created_at, id').all(who).map((r) => ({ ...r })) as Array<Record<string, unknown>>;
  /** 해지 토큰 하나를 만들어 그 알림에 붙인다 (예약 작업이 메일을 보낼 때 하는 것과 같게 — 해시만 저장). */
  const tokenFor = async (alertId: string) => {
    const t = randomToken(32);
    raw.prepare('INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) VALUES (?,?,0)').run(await sha256Hex(t), alertId);
    return t;
  };
  return { raw, env, sqls, get, post, alerts, tokenFor };
}

const CREATE = { chinese_level: 'business', location: 'seoul', frequency: 'daily', optin: '1' };

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasSqlite)('/jobs 의 만들기 칸', () => {
  it('로그인한 구직자 + 조건이 있을 때만 보인다 (조건 없음·기업·비로그인은 없음)', async () => {
    const w = world();
    const withFilter = await (await w.get('/jobs?chinese_level=business&location=seoul', 's1')).text();
    expect(withFilter).toContain('action="/my/alerts"');
    expect(withFilter).toContain('name="location" value="seoul"');
    expect(withFilter).toContain('알림 메일 수신에 동의합니다');
    expect(await (await w.get('/jobs', 's1')).text()).not.toContain('action="/my/alerts"');
    expect(await (await w.get('/jobs?location=seoul', 'owner')).text()).not.toContain('action="/my/alerts"');
    expect(await (await w.get('/jobs?location=seoul', null)).text()).not.toContain('/my/alerts');
  });

  it('비로그인 /jobs HTML 은 다른 사람의 로그인·알림과 관계없이 같다 (캐시되는 화면에 사용자별 내용 없음)', async () => {
    const w = world();
    const before = await (await w.get('/jobs?location=seoul', null)).text();
    await w.get('/jobs?location=seoul', 's1');
    expect((await w.post('/my/alerts', CREATE, 's1')).status).toBe(303);
    const res = await w.get('/jobs?location=seoul', null);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.text()).toBe(before);
    // 로그인한 화면은 캐시하지 않는다
    expect((await w.get('/jobs?location=seoul', 's1')).headers.get('Cache-Control')).toBe(NO_STORE);
  });
});

describe.skipIf(!hasSqlite)('만들기 POST /my/alerts', () => {
  it('정규화한 조건(/jobs 파서)·빈도·수신 동의 시각과 판을 저장한다', async () => {
    const w = world();
    const res = await w.post('/my/alerts', { ...CREATE, role_category: 'sales', evil: "x' OR 1=1", lang: 'zh' }, 's1');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/my/alerts?ok=created');
    const [a] = w.alerts('s1');
    // role_category 는 기본 설정에서 숨겨진 필터 → /jobs 처럼 버려진다. 모르는 이름도 버려진다.
    expect(a).toMatchObject({ filter_json: '{"chinese_level":"business","location":"seoul"}', frequency: 'daily', status: 'active', optin_version: ALERT_OPTIN_VERSION, fail_count: 0 });
    expect(Number(a!.optin_at)).toBeGreaterThan(0);
    expect(Number(a!.next_due_at)).toBeGreaterThan(Number(a!.created_at));
    expect(a!.checked_until).toBe(a!.created_at);
  });

  it('수신 동의 체크가 없거나·조건이 없거나·빈도가 이상하면 400 + 저장 없음', async () => {
    const w = world();
    for (const [form, msg] of [
      [{ ...CREATE, optin: '' }, '알림 메일 수신 동의에 체크해 주세요'],
      [{ frequency: 'daily', optin: '1' }, '조건을 하나 이상'],
      [{ location: 'mars', frequency: 'daily', optin: '1' }, '조건을 하나 이상'],
      [{ ...CREATE, frequency: 'hourly' }, '메일 빈도를 골라'],
    ] as const) {
      const res = await w.post('/my/alerts', form as Record<string, string>, 's1');
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(msg);
    }
    expect(w.alerts('s1')).toEqual([]);
  });

  it(`최대 ${ALERT_MAX_PER_USER}개, 같은 조건은 한 번`, async () => {
    const w = world();
    const forms: Record<string, string>[] = [
      { location: 'seoul' }, { location: 'busan' }, { chinese_level: 'business' }, { chinese_level: 'native' }, { report_line: 'cn_hq' }, { report_line: 'kr_head' },
    ];
    expect((await w.post('/my/alerts', { ...forms[0]!, frequency: 'daily', optin: '1' }, 's1')).status).toBe(303);
    const dup = await w.post('/my/alerts', { ...forms[0]!, frequency: 'weekly', optin: '1' }, 's1');
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('같은 조건의 알림이 이미 있습니다');
    for (const f of forms.slice(1, 5)) expect((await w.post('/my/alerts', { ...f, frequency: 'daily', optin: '1' }, 's1')).status).toBe(303);
    const sixth = await w.post('/my/alerts', { ...forms[5]!, frequency: 'daily', optin: '1' }, 's1');
    expect(sixth.status).toBe(400);
    expect(await sixth.text()).toContain(`${ALERT_MAX_PER_USER}개까지`);
    expect(w.alerts('s1')).toHaveLength(ALERT_MAX_PER_USER);
    expect((await w.post('/my/alerts', { ...forms[5]!, frequency: 'daily', optin: '1' }, 's2')).status).toBe(303); // 다른 사람은 따로
  });

  it('구직자만: 비로그인 → /login, 기업·관리자 403, 모든 응답 no-store, 출처 없는 POST 403', async () => {
    const w = world();
    const anon = await w.get('/my/alerts', null);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/login');
    expect(anon.headers.get('Cache-Control')).toBe(NO_STORE);
    for (const who of ['owner', 'adm'] as const) {
      const r = await w.get('/my/alerts', who);
      expect(r.status, who).toBe(403);
      expect(r.headers.get('Cache-Control')).toBe(NO_STORE);
      expect((await w.post('/my/alerts', CREATE, who)).status).toBe(403);
    }
    expect((await w.post('/my/alerts', CREATE, 's1', { origin: null })).status).toBe(403);
    expect((await w.post('/my/alerts', CREATE, 's1', { origin: 'https://evil.example' })).status).toBe(403);
    expect(w.alerts('s1')).toEqual([]);
  });
});

describe.skipIf(!hasSqlite)('목록·빈도·끄기·다시 켜기·삭제', () => {
  it('목록은 지금 항목 이름으로 보이고, 숨긴 조건·사용 종료 항목을 알린다; 남의 알림 id 는 바꾸지 못한다', async () => {
    const w = world();
    await w.post('/my/alerts', CREATE, 's1');
    const [a] = w.alerts('s1');
    const id = String(a!.id);
    let html = await (await w.get('/my/alerts', 's1')).text();
    expect(html).toContain('필요한 중국어 수준: 업무 가능 · 근무지: 서울');
    expect(html).toContain('/jobs?chinese_level=business&amp;location=seoul');
    // 관리자가 근무지 필터를 숨기고 서울 항목을 사용 종료
    w.raw.exec(`INSERT INTO site_settings (key, value, updated_at) VALUES ('public_job_filters', '["chinese_level"]', 0)`);
    w.raw.exec("UPDATE job_options SET active = 0 WHERE kind = 'location' AND code = 'seoul'");
    html = await (await w.get('/my/alerts', 's1')).text();
    expect(html).toContain('근무지: 서울 (사용 종료된 항목)');
    expect(html).toContain('지금 적용되지 않습니다: 근무지');
    expect(html).toContain('/jobs?chinese_level=business"');
    // 남의 것
    for (const p of ['frequency', 'pause', 'delete']) {
      const r = await w.post(`/my/alerts/${id}/${p}`, { frequency: 'weekly' }, 's2');
      expect(r.headers.get('location'), p).toBe('/my/alerts?err=notfound');
    }
    expect(w.alerts('s1')[0]).toMatchObject({ frequency: 'daily', status: 'active' });
  });

  it('빈도 저장 → 끄기 → 다시 켜기(수신 동의 다시 필요) → 삭제', async () => {
    const w = world();
    await w.post('/my/alerts', CREATE, 's1');
    const id = String(w.alerts('s1')[0]!.id);
    expect((await w.post(`/my/alerts/${id}/frequency`, { frequency: 'weekly' }, 's1')).headers.get('location')).toBe('/my/alerts?ok=saved');
    const weekly = w.alerts('s1')[0]!;
    expect(weekly.frequency).toBe('weekly');
    expect(new Date((Number(weekly.next_due_at) + 9 * 3600) * 1000).getUTCDay()).toBe(1);
    expect((await w.post(`/my/alerts/${id}/pause`, {}, 's1')).headers.get('location')).toBe('/my/alerts?ok=paused');
    expect(w.alerts('s1')[0]).toMatchObject({ status: 'paused', paused_reason: 'user' });
    const noOptin = await w.post(`/my/alerts/${id}/resume`, {}, 's1');
    expect(noOptin.status).toBe(400);
    expect(w.alerts('s1')[0]!.status).toBe('paused');
    w.raw.prepare('UPDATE alerts SET fail_count = 3, checked_until = 5 WHERE id = ?').run(id);
    expect((await w.post(`/my/alerts/${id}/resume`, { optin: '1' }, 's1')).headers.get('location')).toBe('/my/alerts?ok=resumed');
    const resumed = w.alerts('s1')[0]!;
    expect(resumed).toMatchObject({ status: 'active', paused_reason: null, fail_count: 0 });
    expect(Number(resumed.checked_until)).toBeGreaterThan(5); // 꺼져 있던 동안의 공고를 한꺼번에 보내지 않는다
    expect((await w.post(`/my/alerts/${id}/delete`, {}, 's1')).headers.get('location')).toBe('/my/alerts?ok=deleted');
    expect(w.alerts('s1')).toEqual([]);
    expect((await w.post('/my/alerts/not-an-id/delete', {}, 's1')).headers.get('location')).toBe('/my/alerts?err=notfound');
  });
});

describe.skipIf(!hasSqlite)('해지 링크 /alerts/u/:token', () => {
  async function withToken() {
    const w = world();
    await w.post('/my/alerts', CREATE, 's1');
    await w.post('/my/alerts', { location: 'busan', frequency: 'weekly', optin: '1' }, 's1');
    const all = w.alerts('s1');
    const a = all.find((x) => String(x.filter_json).includes('chinese_level'))!;
    const b = all.find((x) => x !== a)!;
    return { w, a: String(a.id), b: String(b.id), token: await w.tokenFor(String(a.id)) };
  }

  it('GET 은 아무것도 바꾸지 않고 조건 요약만 보인다 (이메일 없음, 로그인되지 않음, no-store)', async () => {
    const { w, token } = await withToken();
    for (let i = 0; i < 3; i++) {
      const res = await w.get(`/alerts/u/${token}`, null);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
      expect(res.headers.get('set-cookie')).toBeNull();
      const html = await res.text();
      expect(html).toContain('필요한 중국어 수준: 업무 가능 · 근무지: 서울');
      expect(html).not.toContain(EMAILS.s1);
      expect(html).toContain(`action="/alerts/u/${token}"`);
    }
    const head = await app.fetch(new Request(`${ORIGIN}/alerts/u/${token}`, { method: 'HEAD' }) as never, w.env);
    expect(head.status).toBeLessThan(500);
    expect(w.alerts('s1').every((x) => x.status === 'active')).toBe(true);
  });

  it('확인 화면의 POST 는 그 알림 하나만 끈다', async () => {
    const { w, a, b, token } = await withToken();
    const res = await w.post(`/alerts/u/${token}`, {}, null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('이 알림을 껐습니다');
    const rows = Object.fromEntries(w.alerts('s1').map((x) => [x.id, x]));
    expect(rows[a]).toMatchObject({ status: 'paused', paused_reason: 'unsubscribe' });
    expect(rows[b]).toMatchObject({ status: 'active' });
    // 이미 꺼진 알림의 화면
    expect(await (await w.get(`/alerts/u/${token}`, null)).text()).toContain('이미 꺼져 있습니다');
  });

  it('RFC 8058 한 번 클릭: 쿠키·Origin 없는 POST "List-Unsubscribe=One-Click" → 빈 200, 그 알림을 끈다', async () => {
    const { w, a, token } = await withToken();
    const res = await app.fetch(new Request(`${ORIGIN}/alerts/u/${token}`, {
      method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, w.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(w.alerts('s1').find((x) => x.id === a)).toMatchObject({ status: 'paused', paused_reason: 'unsubscribe' });
  });

  it('출처 검사 예외는 그 경로 하나뿐: /all·/my/alerts·다른 POST 는 Origin 이 없으면 403', async () => {
    const { w, a, token } = await withToken();
    expect((await w.post(`/alerts/u/${token}/all`, {}, null, { origin: null })).status).toBe(403);
    expect((await w.post(`/alerts/u/${token}/all`, {}, null, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await w.post(`/my/alerts/${a}/pause`, {}, 's1', { origin: null })).status).toBe(403);
    expect((await w.post('/logout', {}, 's1', { origin: null })).status).toBe(403);
    expect((await w.post(`/alerts/u/${token}/`, {}, null, { origin: null })).status).toBe(403);
    expect(w.alerts('s1').every((x) => x.status === 'active')).toBe(true);
  });

  it('"모든 알림 끄기" (같은 출처) 는 그 사람의 알림만 모두 끈다', async () => {
    const { w, token } = await withToken();
    await w.post('/my/alerts', CREATE, 's2');
    const res = await w.post(`/alerts/u/${token}/all`, {}, null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('알림 2개를 껐습니다');
    expect(w.alerts('s1').every((x) => x.status === 'paused')).toBe(true);
    expect(w.alerts('s2')[0]!.status).toBe('active');
  });

  it('모르는·모양이 다른 토큰: 일반 안내(404), 한 번 클릭은 빈 200, 아무것도 바뀌지 않는다', async () => {
    const { w, token } = await withToken();
    const other = randomToken(32);
    for (const t of [other, 'short', `${token.slice(0, 42)}!`]) {
      const g = await w.get(`/alerts/u/${encodeURIComponent(t)}`, null);
      expect(g.status, t).toBe(404);
      expect(await g.text()).toContain('링크가 올바르지 않거나 만료되었습니다');
    }
    const p = await w.post(`/alerts/u/${other}`, {}, null, { origin: null, body: 'List-Unsubscribe=One-Click' });
    expect(p.status).toBe(200);
    expect((await w.post(`/alerts/u/${other}`, {}, null)).status).toBe(404);
    expect(w.alerts('s1').every((x) => x.status === 'active')).toBe(true);
  });

  it('동의를 다시 하지 않은 회원(로그인 상태)도 해지 화면을 연다 — /consent 로 보내지 않는다', async () => {
    const w = world();
    w.raw.prepare(`INSERT INTO alerts (id, seeker_id, filter_json, frequency, created_at, status, next_due_at, checked_until, optin_at, optin_version, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000aa', 'late', '{"location":"seoul"}', 'daily', 0, 'active', 1, 0, 1, 'v', 0)`).run();
    const token = await w.tokenFor('00000000-0000-4000-8000-0000000000aa');
    expect((await w.get('/my/alerts', 'late')).status).toBe(302); // 다른 화면은 동의 화면으로
    const res = await w.get(`/alerts/u/${token}`, 'late');
    expect(res.status).toBe(200);
    expect((await w.post(`/alerts/u/${token}`, {}, 'late')).status).toBe(200);
    expect(w.alerts('late')[0]!.status).toBe('paused');
  });
});

describe.skipIf(!hasSqlite)('관리자', () => {
  it('/admin/system 에는 개수만 (누구의 어떤 조건인지 없음)', async () => {
    const w = world();
    await w.post('/my/alerts', CREATE, 's1');
    await w.post('/my/alerts', { location: 'busan', frequency: 'daily', optin: '1' }, 's2');
    await w.post(`/my/alerts/${String(w.alerts('s2')[0]!.id)}/pause`, {}, 's2');
    const html = await (await w.get('/admin/system', 'adm')).text();
    expect(html).toContain('조건 알림');
    expect(html).toMatch(/켜진 알림<\/th><td class="num">1</);
    expect(html).toMatch(/꺼진 알림<\/th><td class="num">1</);
    expect(html).toContain('0 / 40');
    expect(html).toContain('sendAlerts');
    for (const x of [EMAILS.s1, EMAILS.s2, 'seoul', 'busan', '서울', '부산']) expect(html, x).not.toContain(x);
  });
  it('관리자에게 알림을 만들거나 보내는 경로가 없다', async () => {
    const w = world();
    for (const p of ['/admin/alerts', '/admin/alerts/send', '/admin/system/alerts']) {
      expect((await w.get(p, 'adm')).status, p).toBe(404);
      expect((await w.post(p, {}, 'adm')).status, p).toBe(404);
    }
  });
});
