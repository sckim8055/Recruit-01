// T-12c 화면: 관리자 보관 기간 두 단계 저장, 기간을 늘리면 개인정보 동의 다시 받기, /privacy·/consent 의 숫자, 쓰지 않은 초안 삭제.
// app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts). 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { sha256Hex } from '../src/lib/crypto';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/consent';
import { DEFAULT_RETENTION, RETENTION_LOG_MAX, parseRetention, parseRetentionLog } from '../src/lib/retention';
import { hasSqlite, migratedDb } from './sqlite-d1';

const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';
const NO_STORE = 'private, no-store';
const J_PUB = '11111111-1111-4111-8111-111111111111';
const J_DRAFT = '22222222-2222-4222-8222-222222222222';
const J_WAS_PUB = '33333333-3333-4333-8333-333333333333';
const J_CLOSED = '44444444-4444-4444-8444-444444444444';
const J_BLOCKED = '55555555-5555-4555-8555-555555555555';
const J_OTHER = '66666666-6666-4666-8666-666666666666';
const J_DRAFT_APPS = '77777777-7777-4777-8777-777777777777';

type Who = 's1' | 's2' | 'co' | 'co2' | 'adm';

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','fake.s1@example.test','seeker','active',0), ('s2','fake.s2@example.test','seeker','active',0),
    ('co','fake.co@example.test','company','active',0), ('co2','fake.co2@example.test','company','active',0),
    ('adm','fake.adm@example.test','admin','active',0)`);
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0), ('c2','다른기업','kr_entity','verified',0)`);
  raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','co','owner',0,0), ('c2','co2','owner',0,0)`);
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_zh, source_zh, title_ko, body_ko, localize_status, status, published_at, created_at, updated_at) VALUES
    ('${J_PUB}','c1','co','office','销售','内容','영업','본문','approved','published',1,0,0),
    ('${J_DRAFT}','c1','co','office','草稿','内容',NULL,NULL,'draft','draft',NULL,0,0),
    ('${J_WAS_PUB}','c1','co','office','曾发布','内容','예전','본문','approved','draft',5,0,0),
    ('${J_CLOSED}','c1','co','office','截止','内容','마감','본문','approved','closed',5,0,0),
    ('${J_BLOCKED}','c1','co','office','屏蔽','内容','차단','본문','approved','blocked',NULL,0,0),
    ('${J_OTHER}','c2','co2','office','别家','内容',NULL,NULL,'draft','draft',NULL,0,0),
    ('${J_DRAFT_APPS}','c1','co','office','有应聘','内容',NULL,NULL,'draft','draft',NULL,0,0)`);
  // 게재된 적 없는 초안에 지원이 붙은 이상한 경우(손으로 넣은 행) — 그래도 지우지 않는다
  raw.exec(`INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status, status_changed_at, created_at) VALUES ('ax','${J_DRAFT_APPS}','s2','','withdrawn',0,0)`);
  const sqls: string[] = [];
  const db = {
    prepare: (sql: string) => { sqls.push(sql); return d1.prepare(sql); },
    batch: (s: never) => d1.batch(s),
  } as unknown as D1Database;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES: {}, ENC_KEY: '', SESSION_PEPPER: PEPPER, REGISTRATION_NO: '', MAIL_FROM: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const tokens = new Map<Who, string>();
  const cookie = async (who: Who | null, lang = 'ko') => {
    if (!who) return { cookie: `lang=${lang}` };
    if (!tokens.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      tokens.set(who, token);
    }
    return { cookie: `sid=${tokens.get(who)}; lang=${lang}` };
  };
  const get = async (path: string, who: Who | null = 's1', lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who, lang) }) as never, env);
  const post = async (path: string, form: Record<string, string> = {}, who: Who | null = 's1') =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST', body: new URLSearchParams(form),
      headers: { ...(await cookie(who)), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, env);
  const agree = (who: string, privacy = PRIVACY_VERSION) => {
    raw.prepare("INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?,'terms',?,NULL,1)").run(`t-${who}`, who, TERMS_VERSION);
    raw.prepare("INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?,'privacy',?,NULL,1)").run(`p-${who}-${privacy}`, who, privacy);
  };
  for (const w of ['s1', 's2', 'co', 'co2'] as const) agree(w);
  const one = (sql: string, ...a: unknown[]) => { const r = raw.prepare(sql).get(...(a as never[])); return r ? { ...r } : undefined; };
  const setting = (key: string) => (one('SELECT value FROM site_settings WHERE key = ?', key)?.value as string | undefined) ?? null;
  return { raw, env, sqls, get, post, one, setting };
}
type World = ReturnType<typeof world>;

const FORM = {
  application_keep_days: '180', application_auto_close_days: '30', vdoc_keep_days: '365', access_log_keep_days: '730', job_stale_days: '30',
};

/** 1단계 → 확인 화면에서 숨은 칸을 읽어 2단계로 보낸다 (브라우저가 하는 것과 같다). */
async function saveRetention(w: World, p: Record<string, string>, o: { confirm?: boolean } = {}) {
  const step1 = await w.post('/admin/settings/retention', { ...FORM, ...p }, 'adm');
  expect(step1.status).toBe(200);
  const html = await step1.text();
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replaceAll('&quot;', '"')]));
  const res = await w.post('/admin/settings/retention/confirm', { ...hidden, ...(o.confirm === false ? {} : { confirm: '1' }) }, 'adm');
  return { html, hidden, res };
}

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})); });
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe.skipIf(!hasSqlite)('관리자 보관 기간 설정', () => {
  it('설정 화면: 지금 값·범위·안내, 바꾼 적 없음', async () => {
    const w = world();
    const res = await w.get('/admin/settings', 'adm');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/settings/retention"');
    expect(html).toContain('name="application_keep_days" value="180" min="30" max="365"');
    expect(html).toContain('30~365일 (기본 180일).');
    expect(html).toContain('name="job_stale_off"');
    expect(html).toContain('&quot;영구 보관&quot;');
    expect(html).toContain('아직 바꾼 적이 없습니다');
    const zh = await (await w.get('/admin/settings', 'adm', 'zh')).text();
    expect(zh).toContain('保存期限');
  });

  it('관리자가 아니면 403 (구직자·기업), 비로그인은 로그인으로', async () => {
    const w = world();
    for (const who of ['s1', 'co'] as const) {
      expect((await w.get('/admin/settings', who)).status).toBe(403);
      expect((await w.post('/admin/settings/retention', FORM, who)).status).toBe(403);
      expect((await w.post('/admin/settings/retention/confirm', { ...FORM, confirm: '1', base: '' }, who)).status).toBe(403);
    }
    expect((await w.post('/admin/settings/retention/confirm', { ...FORM, confirm: '1' }, null)).status).toBe(302);
    expect(w.setting('retention')).toBeNull();
  });

  it('검사 오류: 400 + 입력 유지 + 칸별 오류, 저장 없음', async () => {
    const w = world();
    const res = await w.post('/admin/settings/retention', { ...FORM, application_keep_days: '20', application_auto_close_days: '5', access_log_keep_days: 'abc' }, 'adm');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('name="application_keep_days" value="20"');
    expect(html).toContain('name="access_log_keep_days" value="abc"');
    expect(html).toContain('30~365 사이로 입력해 주세요.');
    expect(html).toContain('7~90 사이로 입력해 주세요.');
    expect(html).toContain('일 수를 정수로 입력해 주세요.');
    const r2 = await w.post('/admin/settings/retention', { ...FORM, application_keep_days: '60', application_auto_close_days: '60' }, 'adm');
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('지원서 보관 기간보다 짧아야 합니다.');
    // 확인 단계로 위조한 값을 보내도 다시 검사한다
    const forged = await w.post('/admin/settings/retention/confirm', { ...FORM, application_keep_days: '0', confirm: '1', base: '' }, 'adm');
    expect(forged.status).toBe(400);
    expect(w.setting('retention')).toBeNull();
  });

  it('확인 화면: 바뀌는 값 old → new 와 결과, "확인했습니다" 없으면 저장하지 않는다', async () => {
    const w = world();
    const { html, res } = await saveRetention(w, { application_keep_days: '90', job_stale_days: '', job_stale_off: '1' }, { confirm: false });
    expect(html).toContain('보관 기간 변경 확인');
    expect(html).toMatch(/지원서 보관 \(공고 마감 확인 후\)<\/td><td>180일<\/td><td><b>90일<\/b>/);
    expect(html).toMatch(/마감일 없는 공고 자동 마감 \(마지막 저장 후\)<\/td><td>30일<\/td><td><b>끔<\/b>/);
    expect(html).toContain('이미 있는 자료도 더 일찍 삭제되며 되돌릴 수 없습니다');
    expect(html).toContain('자동 마감과 그 안내 메일이 꺼집니다');
    expect(html).not.toContain('다시 동의해야');
    expect(html).toContain('name="confirm" value="1" required');
    expect(html).not.toContain('사업자 서류 보관 (확인 후)</td>'); // 안 바뀐 칸은 표에 없다
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('&quot;확인했습니다&quot;를 체크해야 저장됩니다.');
    expect(w.setting('retention')).toBeNull();
  });

  it('저장: 값·누가·언제, 변경 기록, 줄이기는 rev 그대로 / 늘리기는 rev +1', async () => {
    const w = world();
    const s1 = await saveRetention(w, { application_keep_days: '90' });
    expect([s1.res.status, s1.res.headers.get('location')]).toEqual([303, '/admin/settings?ok=retention_saved#retention']);
    expect(parseRetention(w.setting('retention'))).toEqual({ ...DEFAULT_RETENTION, application_keep_days: 90, rev: 0 });
    expect(w.one("SELECT updated_by FROM site_settings WHERE key = 'retention'")).toEqual({ updated_by: 'adm' });
    const page = await (await w.get('/admin/settings?ok=retention_saved', 'adm')).text();
    expect(page).toContain('보관 기간을 저장했습니다.');
    expect(page).toContain('마지막 변경: fake.adm@example.test');
    expect(page).toContain('name="application_keep_days" value="90"');
    expect(page).toContain('지원서 보관 180일 → 90일');
    const s2 = await saveRetention(w, { application_keep_days: '120' });
    expect(s2.html).toContain('다시 동의해야');
    expect(s2.html).toContain('저장한 뒤에 낸 지원서에만 적용됩니다');
    expect(parseRetention(w.setting('retention'))).toMatchObject({ application_keep_days: 120, rev: 1 });
    const log = parseRetentionLog(w.setting('retention.log'));
    expect(log.map((e) => e.changes)).toEqual([
      [{ key: 'application_keep_days', from: 180, to: 90 }], [{ key: 'application_keep_days', from: 90, to: 120 }],
    ]);
    expect(log.every((e) => e.by === 'adm' && typeof e.at === 'number')).toBe(true);
    expect(w.setting('retention.log')).not.toMatch(/@/); // id·숫자만
    // 바뀐 것이 없으면 확인 화면 없이 안내
    const same = await w.post('/admin/settings/retention', { ...FORM, application_keep_days: '120' }, 'adm');
    expect([same.status, same.headers.get('location')]).toEqual([303, '/admin/settings?ok=retention_unchanged#retention']);
  });

  it('변경 기록은 최근 20줄', async () => {
    const w = world();
    for (let i = 0; i < 22; i++) await saveRetention(w, { job_stale_days: String(14 + i) });
    const log = parseRetentionLog(w.setting('retention.log'));
    expect(log).toHaveLength(RETENTION_LOG_MAX);
    expect(log.at(-1)!.changes).toEqual([{ key: 'job_stale_days', from: 34, to: 35 }]);
    expect(parseRetention(w.setting('retention')).rev).toBe(0); // 자동 마감은 다시 동의를 받지 않는다
  });

  it('확인 화면을 연 뒤 다른 관리자가 바꿨으면 저장하지 않고 지금 값으로 다시 확인', async () => {
    const w = world();
    const step1 = await (await w.post('/admin/settings/retention', { ...FORM, application_keep_days: '90' }, 'adm')).text();
    const base = /name="base" value="([^"]*)"/.exec(step1)![1]!.replaceAll('&quot;', '"');
    await saveRetention(w, { vdoc_keep_days: '730' }); // 그사이 다른 저장
    const res = await w.post('/admin/settings/retention/confirm', { ...FORM, application_keep_days: '90', base, confirm: '1' }, 'adm');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('확인 화면을 연 뒤 보관 기간이 바뀌었습니다');
    expect(html).toMatch(/사업자 서류 보관 \(확인 후\)<\/td><td>730일<\/td><td><b>365일<\/b>/); // 지금 값 기준
    expect(parseRetention(w.setting('retention'))).toMatchObject({ application_keep_days: 180, vdoc_keep_days: 730 });
  });
});

describe.skipIf(!hasSqlite)('방침·동의 문구의 숫자와 다시 동의', () => {
  it('/privacy 와 /consent 는 지금 설정의 숫자를 보인다 (한·중), 자리표시자가 남지 않는다', async () => {
    const w = world();
    expect(await (await w.get('/privacy', null)).text()).toContain('중단된 뒤 180일까지');
    await saveRetention(w, { application_keep_days: '90', access_log_keep_days: '1095' });
    const ko = await (await w.get('/privacy', null)).text();
    const zh = await (await w.get('/privacy', null, 'zh')).text();
    expect(ko).toContain('중단된 뒤 90일까지');
    expect(ko).toContain('열람 기록: 3년(');
    expect(zh).toContain('停止发布后90天再删除');
    expect(zh).toContain('查看记录：3年（');
    for (const h of [ko, zh]) expect(h).not.toMatch(/\{(application_keep_days|application_auto_close_days|vdoc_keep|access_log_keep|stale_days)\}/);
    w.raw.exec("DELETE FROM consents WHERE user_id = 's2' AND type = 'privacy'");
    const consent = await (await w.get('/consent', 's2')).text();
    expect(consent).toContain('공고 마감 후 90일까지, 열람 기록은 3년');
  });

  it('줄이기는 다시 묻지 않고, 늘리면 동의한 회원도 다음 요청에서 /consent → 개인정보만 새 판(+r1)으로 기록', async () => {
    const w = world();
    expect((await w.get('/my/applications', 's1')).status).toBe(200);
    await saveRetention(w, { application_keep_days: '90' });
    expect((await w.get('/my/applications', 's1')).status).toBe(200); // 줄이기: 그대로
    await saveRetention(w, { application_keep_days: '120' });
    const res = await w.get('/my/applications', 's1');
    expect([res.status, res.headers.get('location')]).toEqual([302, '/consent?next=%2Fmy%2Fapplications']);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect((await w.post('/my/resumes/new', {}, 's1')).status).toBe(403); // 그 밖의 메서드는 처리하지 않는다
    const page = await (await w.get('/consent?next=%2Fmy%2Fapplications', 's1')).text();
    expect(page).not.toContain('name="terms"');      // 약관은 이미 동의 → 칸 없음
    expect(page).toContain('name="privacy"');
    expect(page).toContain('공고 마감 후 120일까지');
    const before = Number(w.one('SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', 's1')!.n);
    const done = await w.post('/consent', { privacy: '1', next: '/my/applications' }, 's1');
    expect([done.status, done.headers.get('location')]).toEqual([303, '/my/applications']);
    const rows = w.raw.prepare("SELECT type, version FROM consents WHERE user_id = 's1' ORDER BY agreed_at, type").all().map((r) => ({ ...r }));
    expect(rows).toEqual([
      { type: 'privacy', version: PRIVACY_VERSION }, { type: 'terms', version: TERMS_VERSION }, { type: 'privacy', version: `${PRIVACY_VERSION}+r1` },
    ]);
    expect(Number(w.one('SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', 's1')!.n)).toBe(before + 1);
    expect((await w.get('/my/applications', 's1')).status).toBe(200);
    // 계정 화면: 새 판 동의함
    expect(await (await w.get('/my/account', 's1')).text()).toContain(`${PRIVACY_VERSION}+r1`);
    // 다른 회원(기업 담당자)도 다시 묻는다, 관리자는 묻지 않는다
    expect((await w.get('/biz', 'co')).headers.get('location')).toBe('/consent?next=%2Fbiz');
    expect((await w.get('/admin', 'adm')).status).toBe(200);
  });

  it('로그인한 요청의 동의 확인은 읽기 두 번(동의 + 설정 한 행), 비로그인은 읽지 않는다', async () => {
    const w = world();
    w.sqls.length = 0;
    await w.get('/terms', null);
    expect(w.sqls.filter((s) => s.includes('FROM consents') || s.includes('FROM site_settings'))).toEqual([]);
    w.sqls.length = 0;
    await w.get('/my/applications', 's1');
    expect(w.sqls.filter((s) => s.includes('FROM consents')).length).toBe(1);
    expect(w.sqls.filter((s) => s.includes('FROM site_settings')).length).toBe(1);
  });
});

describe.skipIf(!hasSqlite)('쓰지 않은 초안 삭제', () => {
  const exists = (w: World, id: string) => w.one('SELECT 1 AS x FROM jobs WHERE id = ?', id) !== undefined;

  it('게재된 적 없고 지원 없는 초안: 확인 화면 → 삭제', async () => {
    const w = world();
    const list = await (await w.get('/biz/jobs', 'co')).text();
    expect(list).toContain(`href="/biz/jobs/${J_DRAFT}/delete"`);
    for (const id of [J_PUB, J_WAS_PUB, J_CLOSED, J_BLOCKED, J_DRAFT_APPS]) expect(list, id).not.toContain(`/biz/jobs/${id}/delete`);
    expect(await (await w.get(`/biz/jobs/${J_DRAFT}`, 'co')).text()).toContain(`href="/biz/jobs/${J_DRAFT}/delete"`);
    expect(await (await w.get(`/biz/jobs/${J_WAS_PUB}`, 'co')).text()).not.toContain('/delete"');
    const confirm = await w.get(`/biz/jobs/${J_DRAFT}/delete`, 'co');
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    expect(html).toContain(`action="/biz/jobs/${J_DRAFT}/delete"`);
    expect(html).toContain('되돌릴 수 없습니다');
    expect(exists(w, J_DRAFT)).toBe(true); // GET 은 지우지 않는다
    const res = await w.post(`/biz/jobs/${J_DRAFT}/delete`, {}, 'co');
    expect([res.status, res.headers.get('location')]).toEqual([303, '/biz/jobs?ok=deleted']);
    expect(exists(w, J_DRAFT)).toBe(false);
    expect(await (await w.get('/biz/jobs?ok=deleted', 'co')).text()).toContain('공고를 삭제했습니다.');
    expect((await w.get(`/biz/jobs/${J_DRAFT}/delete`, 'co')).status).toBe(404);
  });

  it('게재 중·마감·차단·한 번이라도 게재된 초안·지원이 있는 초안은 지울 수 없다 (GET·POST 모두 400, 행 그대로)', async () => {
    const w = world();
    for (const id of [J_PUB, J_CLOSED, J_BLOCKED, J_WAS_PUB, J_DRAFT_APPS]) {
      const g = await w.get(`/biz/jobs/${id}/delete`, 'co');
      expect(g.status, id).toBe(400);
      expect(await g.text()).toContain('이 공고는 지울 수 없습니다');
      expect((await w.post(`/biz/jobs/${id}/delete`, {}, 'co')).status, id).toBe(400);
      expect(exists(w, id), id).toBe(true);
    }
  });

  it('다른 기업의 초안은 404, 구직자 403, 행 그대로', async () => {
    const w = world();
    expect((await w.get(`/biz/jobs/${J_OTHER}/delete`, 'co')).status).toBe(404);
    expect((await w.post(`/biz/jobs/${J_OTHER}/delete`, {}, 'co')).status).toBe(404);
    expect((await w.post(`/biz/jobs/${J_DRAFT}/delete`, {}, 's1')).status).toBe(403);
    expect(exists(w, J_OTHER)).toBe(true);
    expect(exists(w, J_DRAFT)).toBe(true);
  });

  it('DB 문장이 세 조건을 다시 확인한다 (화면 확인과 삭제 사이에 게재된 경우)', async () => {
    const w = world();
    const { deleteUnusedDraft } = await import('../src/db/jobs');
    w.raw.exec(`UPDATE jobs SET published_at = 9 WHERE id = '${J_DRAFT}'`);
    expect(await deleteUnusedDraft((w.env as { DB: D1Database }).DB, { id: J_DRAFT, companyId: 'c1' })).toBe(false);
    w.raw.exec(`UPDATE jobs SET published_at = NULL WHERE id = '${J_DRAFT}'`);
    expect(await deleteUnusedDraft((w.env as { DB: D1Database }).DB, { id: J_DRAFT, companyId: 'c2' })).toBe(false); // 다른 기업
    expect(await deleteUnusedDraft((w.env as { DB: D1Database }).DB, { id: J_DRAFT_APPS, companyId: 'c1' })).toBe(false); // 지원 있음
    expect(await deleteUnusedDraft((w.env as { DB: D1Database }).DB, { id: J_DRAFT, companyId: 'c1' })).toBe(true);
  });

  it('초안 한도 안내에 쓰지 않는 초안 삭제를 적는다 (한·중)', async () => {
    const { t } = await import('../src/lib/i18n');
    expect(t('ko', 'quota.drafts')).toContain('"삭제"로 지울 수 있습니다');
    expect(t('zh', 'quota.drafts')).toContain('“删除”');
  });
});
