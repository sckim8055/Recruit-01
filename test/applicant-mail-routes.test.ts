// 기업 → 지원자 메일 화면 (T-09b) — app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts) + 가짜 R2 + Resend 호출을 잡는 fetch.
// 지원서는 구직자 화면(T-08)으로 실제로 낸다. 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { INTERVIEW_MAIL_MAX, rejectMail } from '../src/lib/applicant-mail';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { t } from '../src/lib/i18n';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';

// 가짜 개인정보 (화면·주소·로그에 나오면 안 되는 값)
const SEEKERS = {
  s1: { name: '가짜지원자일', email: 'fake.one@example.test' },
  s2: { name: '가짜지원자이', email: 'fake.two@example.test' },
  s3: { name: '가짜지원자삼', email: 'fake.three@example.test' },
} as const;
const PHONE = '010-9999-0000';
const HEADLINE = '가짜한줄소개문장';
const MSG = '您好，请于11月25日14:00来首尔江南区办公室面试。\n请携带身份证。';
const MSG_KO = '안녕하세요. 11월 25일 14:00에 서울 강남구 사무실로 면접에 와 주세요.\n신분증을 지참해 주세요.';
const SECRETS = [...Object.values(SEEKERS).flatMap((s) => [s.name, s.email]), PHONE, HEADLINE];

const J1 = '11111111-1111-4111-8111-111111111111'; // c1: 한국 담당자(co, owner) + 본사 담당자(hq1)
const J9 = '99999999-9999-4999-8999-999999999999'; // c3 공고 (다른 기업)
const TITLE1 = '가짜 영업 매니저';

type Who = 's1' | 's2' | 's3' | 'co' | 'hq1' | 'co3' | 'adm';
type Form = Record<string, string> | Array<[string, string]>;

function world(o: { engine?: string } = {}) {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0), ('s3','s3@example.test','seeker','active',0),
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
    get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(0), body: v } : null; },
    delete: async (k: string) => { store.delete(k); },
  };
  // 번역 엔진: Workers AI 바인딩 흉내 (o.engine 이 있을 때만). 받은 입력을 모아 둔다.
  const engineInputs: string[] = [];
  const AI = o.engine === undefined ? undefined : {
    run: async (_model: string, input: unknown) => { engineInputs.push(JSON.stringify(input)); return { response: o.engine }; },
  };
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    RESEND_API_KEY: 'test-key', MAIL_FROM: 'Recruit <no-reply@x.test>',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
    ...(AI ? { AI } : {}),
  } as never;
  // Resend 호출을 잡는다
  const mails: Array<{ to: string[]; subject: string; text: string; reply_to?: string }> = [];
  let mailMode: 'ok' | 'fail' | 'throw' = 'ok';
  vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => {
    expect(String(u)).toBe('https://api.resend.com/emails');
    if (mailMode === 'throw') throw new TypeError('network');
    mails.push(JSON.parse(String(init!.body)));
    return new Response('{}', { status: mailMode === 'ok' ? 200 : 500 });
  }));
  const sessions = new Map<Who, string>();
  const cookie = async (who: Who | null, lang: string): Promise<Record<string, string>> => {
    if (!who) return { cookie: `lang=${lang}` };
    if (!sessions.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      sessions.set(who, token);
    }
    return { cookie: `sid=${sessions.get(who)}; lang=${lang}` };
  };
  const get = async (path: string, who: Who | null = 'co', lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who, lang) }) as never, env);
  const post = async (path: string, form: FormData | Form = {}, who: Who | null = 'co', lang = 'ko') => {
    const body = form instanceof FormData ? form : new URLSearchParams(form);
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { ...(await cookie(who, lang)), origin: ORIGIN } }) as never, env);
  };
  const rows = (sql: string, ...a: unknown[]) => raw.prepare(sql).all(...(a as never[])).map((r) => ({ ...r }));
  const events = () => rows('SELECT application_id, event, actor_id FROM application_events WHERE event != ? ORDER BY at, rowid', 'viewed');
  const statusOf = (id: string) => String(raw.prepare('SELECT status FROM applications WHERE id = ?').get(id)!.status);
  return {
    raw, env, get, post, rows, events, statusOf, mails, engineInputs,
    setMail: (m: typeof mailMode) => { mailMode = m; },
  };
}
type World = ReturnType<typeof world>;

/** 구직자 화면으로 이력서(경력 요약, 첨부 없음)를 만들고 지원한다. 지원 id 를 돌려준다. */
async function applyAs(w: World, who: 's1' | 's2' | 's3', o: { consent?: boolean; job?: string } = {}) {
  const s = SEEKERS[who];
  const fd = new FormData();
  const fields = { title: '영업직용', name: s.name, chinese_level: 'business', years: '5', headline: HEADLINE, contact_email: s.email, phone: PHONE, desired_role: '영업', experience_text: '경력 요약 가짜' };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('attachment', new File([], '', { type: 'application/octet-stream' }));
  expect((await w.post('/my/resumes/new', fd, who)).status).toBe(302);
  const resumeId = String(w.raw.prepare('SELECT id FROM resumes WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').get(who)!.id);
  const { title: _t, ...rest } = fields;
  const form: Record<string, string> = { resume_id: resumeId, ...rest };
  if (o.consent) form.consent = '1';
  const res = await w.post(`/jobs/${o.job ?? J1}/apply`, form, who);
  expect(res.status).toBe(302);
  return /\/my\/applications\/([0-9a-f-]{36})\?ok=/.exec(res.headers.get('location') ?? '')![1]!;
}

/** 세 지원 (s1·s2·s3 순서) + 새 지원자 알림 메일은 지운다. */
async function three(w: World) {
  const a = await applyAs(w, 's1');
  const b = await applyAs(w, 's2', { consent: true });
  const c = await applyAs(w, 's3');
  w.raw.prepare('UPDATE applications SET created_at = created_at + 10 WHERE id = ?').run(b);
  w.raw.prepare('UPDATE applications SET created_at = created_at + 20 WHERE id = ?').run(c);
  w.mails.length = 0;
  return { a, b, c };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const noStore = (r: Response) => expect(r.headers.get('cache-control')).toBe('private, no-store');

describe.skipIf(!hasSqlite)('기업 → 지원자 메일 (T-09b)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>, errSpy: ReturnType<typeof vi.spyOn>, warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    // RESEND 키가 있으므로 dev 메일 출력도 없다. 이 화면들의 코드는 콘솔에 아무것도 쓰지 않는다 (엔진 실패 줄은 엔진 id·오류 종류뿐).
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    for (const call of errSpy.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).toMatch(/^message: engine=\w+ failed=\w+$/);
      for (const s of [...SECRETS, MSG]) expect(line).not.toContain(s);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('지원서 화면의 면접 요청 칸 → 입력 오류는 글을 지닌 쓰기 화면, 엔진 없음은 원문만 안내, 고치기는 POST 로 글 유지. 열람 기록은 처음 한 번뿐', async () => {
    const w = world();
    const { a } = await three(w);
    const page = await w.get(`/biz/applications/${a}`);
    noStore(page);
    const ph = await page.text();
    expect(ph).toContain('면접 요청 보내기');
    expect(ph).toContain(`action="/biz/applications/${a}/interview/preview"`);
    expect(ph).toContain('3번 더 보낼 수 있습니다');
    expect(ph).toContain('co@example.test'); // 답장 주소 = 담당자 본인
    expect(ph).toContain(`action="/biz/jobs/${J1}/applicants/reject/confirm"`);
    const logs = () => w.rows("SELECT * FROM access_log WHERE target_type = 'application'").length;
    expect(logs()).toBe(1);

    const empty = await w.post(`/biz/applications/${a}/interview/preview`, { message: '   ' });
    expect(empty.status).toBe(400);
    noStore(empty);
    const eh = await empty.text();
    expect(eh).toContain('메시지를 입력해 주십시오');
    expect(eh).toContain('1번 지원자');
    for (const s of SECRETS) expect(eh).not.toContain(s);

    const long = 'x'.repeat(2001);
    const tl = await w.post(`/biz/applications/${a}/interview/preview`, { message: long });
    expect(tl.status).toBe(400);
    const th = await tl.text();
    expect(th).toContain('2000자까지 쓸 수 있습니다');
    expect(th).toContain(long); // 쓴 글은 그대로

    const pv = await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG });
    expect(pv.status).toBe(200);
    noStore(pv);
    const pvh = await pv.text();
    expect(pvh).toContain('한국어 번역을 만들지 못했습니다. 원문만 보냅니다.');
    expect(pvh).toContain(`action="/biz/applications/${a}/interview/send"`);
    expect(pvh).toContain(`formaction="/biz/applications/${a}/interview/compose"`);
    expect(pvh).toContain(`name="message" value="${esc(MSG)}"`);
    expect(pvh).not.toContain('name="translation"');
    for (const s of SECRETS) expect(pvh).not.toContain(s);

    const back = await w.post(`/biz/applications/${a}/interview/compose`, { message: MSG });
    expect(back.status).toBe(200);
    expect(await back.text()).toContain(`${esc(MSG)}</textarea>`);
    expect(logs()).toBe(1); // 쓰기·미리 보기는 지원서를 열지 않는다
    expect(w.mails).toHaveLength(0);
    expect(w.events()).toEqual([]);
  });

  it('번역 엔진이 있으면 원문과 번역을 나란히 → 보내면 지원자 연락 이메일로 한 통(답장 = 담당자), 상태 면접 요청, 이벤트 하나, 목록·구직자 화면에 반영', async () => {
    const w = world({ engine: JSON.stringify({ ko: MSG_KO }) });
    const { a } = await three(w);
    const pv = await (await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG })).text();
    expect(pv).toContain(esc(MSG_KO));
    expect(pv).toContain('번역 없이 원문만 보내기');
    expect(pv).toContain('원문과 번역이 함께 지원자에게 갑니다');
    // 엔진에는 메시지 글만 (지원자 정보 없음)
    expect(w.engineInputs).toHaveLength(1);
    expect(w.engineInputs[0]).toContain('请于11月25日');
    for (const s of SECRETS) expect(w.engineInputs[0]).not.toContain(s);

    const res = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG, translation: MSG_KO });
    expect(res.status).toBe(303);
    noStore(res);
    const loc = res.headers.get('location')!;
    expect(loc).toBe(`/biz/jobs/${J1}/applicants?ok=interview`);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]).toMatchObject({ to: [SEEKERS.s1.email], reply_to: 'co@example.test' });
    expect(w.mails[0]!.text).toContain(MSG);
    expect(w.mails[0]!.text).toContain(MSG_KO);
    expect(w.mails[0]!.text).toContain('자동 번역');
    expect(w.mails[0]!.subject).toContain('가짜전자');
    expect(w.statusOf(a)).toBe('interview');
    expect(w.events()).toEqual([{ application_id: a, event: 'interview_mail', actor_id: 'co' }]);

    const list = await (await w.get(loc)).text();
    expect(list).toContain('면접 요청 메일을 보냈습니다.');
    expect(list).toContain('면접 요청 1회');
    expect(list).toContain('면접 요청함');
    const my = await (await w.get('/my/applications', 's1')).text();
    expect(my).toContain('면접 요청 받음');

    // "원문만" 을 고르면 번역 없이
    expect((await w.post(`/biz/applications/${a}/interview/send`, { message: MSG, translation: MSG_KO, only_original: '1' })).status).toBe(303);
    expect(w.mails[1]!.text).toContain(MSG);
    expect(w.mails[1]!.text).not.toContain(MSG_KO);
    expect(w.mails[1]!.text).not.toContain('자동 번역');
    // 지나치게 긴 "번역" 은 버린다
    const huge = '가'.repeat(MSG.length * 4 + 201);
    expect((await w.post(`/biz/applications/${a}/interview/send`, { message: MSG, translation: huge })).status).toBe(303);
    expect(w.mails[2]!.text).not.toContain(huge);

    // 4번째는 거부, 메일 없음. 지원서 화면에도 폼 대신 안내
    const fourth = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
    expect(fourth.status).toBe(400);
    expect(await fourth.text()).toContain(`${INTERVIEW_MAIL_MAX}번까지 보낼 수 있습니다. 더 보낼 수 없습니다`);
    expect((await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG })).status).toBe(400);
    expect(w.mails).toHaveLength(3);
    expect(w.events()).toHaveLength(3);
    const ph = await (await w.get(`/biz/applications/${a}`)).text();
    expect(ph).toContain('이미 3번 보냈습니다');
    expect(ph).not.toContain('/interview/preview');
    expect(await (await w.get(`/biz/jobs/${J1}/applicants`)).text()).toContain('면접 요청 3회');
    // 메시지는 D1 어디에도 없다 (email_log 는 템플릿·결과·주소 해시뿐)
    expect(w.rows('SELECT template, result FROM email_log WHERE template = ?', 'interview_request')).toEqual(
      Array(3).fill({ template: 'interview_request', result: 'sent' }));
    const dump = JSON.stringify(w.rows("SELECT name FROM sqlite_master WHERE type = 'table'").flatMap((r) => w.rows(`SELECT * FROM "${String(r.name)}"`)));
    for (const s of ['请于11月25日', '서울 강남구 사무실', SEEKERS.s1.email]) expect(dump).not.toContain(s);
  });

  it('메일이 나가지 않으면(오류 응답·연결 실패) 글을 지닌 화면으로 안내, 이벤트 없음, 상태 그대로', async () => {
    const w = world();
    const { a } = await three(w);
    await w.get(`/biz/applications/${a}`);
    for (const mode of ['fail', 'throw'] as const) {
      w.setMail(mode);
      const r = await w.post(`/biz/applications/${a}/interview/send`, { message: MSG });
      expect(r.status).toBe(400);
      noStore(r);
      const h = await r.text();
      expect(h).toContain('메일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요');
      expect(h).toContain(`name="message" value="${esc(MSG)}"`);
      const rj = await w.post(`/biz/jobs/${J1}/applicants/reject/send`, [['id', a]]);
      expect(rj.headers.get('location')).toBe(`/biz/jobs/${J1}/applicants?ok=rejected&sent=0&failed=1`);
    }
    expect(w.events()).toEqual([]);
    expect(w.statusOf(a)).toBe('viewed');
    w.setMail('ok');
    expect((await w.post(`/biz/applications/${a}/interview/send`, { message: MSG })).status).toBe(303);
    expect(w.statusOf(a)).toBe('interview');
  });

  it('불합격 통보: 확인 화면에 정해진 글과 수 → 2명에게 차례로, 이벤트 하나씩, 체크 칸이 사라지고 구직자는 불합격, 면접 요청은 막힘', async () => {
    const w = world();
    const { a, b, c } = await three(w);
    const list0 = await (await w.get(`/biz/jobs/${J1}/applicants`)).text();
    for (const id of [a, b, c]) expect(list0).toContain(`name="id" value="${id}"`);
    expect(list0).toContain('선택한 지원자에게 불합격 통보');

    const conf = await w.post(`/biz/jobs/${J1}/applicants/reject/confirm`, [['id', b], ['id', c], ['id', b]]);
    expect(conf.status).toBe(200);
    noStore(conf);
    const ch = await conf.text();
    expect(ch).toContain('2명에게 보냅니다.');
    const fixed = rejectMail({ companyName: '가짜전자', jobTitle: TITLE1 }, t);
    expect(ch).toContain(esc(fixed.subject));
    expect(ch).toContain(esc(fixed.text));
    expect(ch).toContain('되돌릴 수 없습니다');
    expect(ch).toContain('"불합격"'.replace(/"/g, '&quot;'));
    expect(ch).toContain('co@example.test');
    expect(ch).toContain(`action="/biz/jobs/${J1}/applicants/reject/send"`);
    for (const s of SECRETS) expect(ch).not.toContain(s);
    expect(w.mails).toHaveLength(0);

    const res = await w.post(`/biz/jobs/${J1}/applicants/reject/send`, [['id', b], ['id', c]]);
    expect(res.status).toBe(303);
    noStore(res);
    expect(res.headers.get('location')).toBe(`/biz/jobs/${J1}/applicants?ok=rejected&sent=2&failed=0`);
    expect(w.mails.map((m) => m.to[0])).toEqual([SEEKERS.s2.email, SEEKERS.s3.email]);
    for (const m of w.mails) expect(m).toMatchObject({ subject: fixed.subject, text: fixed.text, reply_to: 'co@example.test' });
    expect([w.statusOf(a), w.statusOf(b), w.statusOf(c)]).toEqual(['submitted', 'rejected', 'rejected']);
    expect(w.events()).toEqual([
      { application_id: b, event: 'reject_mail', actor_id: 'co' },
      { application_id: c, event: 'reject_mail', actor_id: 'co' },
    ]);
    const list = await (await w.get(res.headers.get('location')!)).text();
    expect(list).toContain('2명에게 불합격 통보를 보냈습니다.');
    expect(list).toContain('불합격 통보함');
    expect(list).toContain(`name="id" value="${a}"`);
    for (const id of [b, c]) expect(list).not.toContain(`value="${id}"`);
    for (const who of ['s2', 's3'] as const) expect(await (await w.get('/my/applications', who)).text()).toContain('불합격');

    // 불합격된 지원에는 면접 요청도, 두 번째 통보도 없다
    const iv = await w.post(`/biz/applications/${b}/interview/send`, { message: MSG });
    expect(iv.status).toBe(400);
    expect(await iv.text()).toContain('이미 끝난 지원입니다');
    expect((await w.post(`/biz/applications/${b}/interview/preview`, { message: MSG })).status).toBe(400);
    const again = await w.post(`/biz/jobs/${J1}/applicants/reject/confirm`, [['id', b]]);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('이미 끝났거나 보낼 수 없는 지원');
    // 끝난 지원이 섞이면 빼고 센다
    expect(await (await w.post(`/biz/jobs/${J1}/applicants/reject/confirm`, [['id', a], ['id', b]])).text()).toContain('1건은 이미 끝났거나');
    expect(w.mails).toHaveLength(2);
    expect(w.rows('SELECT template FROM email_log WHERE template = ?', 'reject_notice')).toHaveLength(2);
  });

  it('고르지 않음·10명 초과는 거절, 다른 공고·다른 기업의 지원이 섞이면 404 이고 메일은 한 통도 없다', async () => {
    const w = world();
    const { a } = await three(w);
    const other = await applyAs(w, 's1', { job: J9 });
    w.mails.length = 0;
    const none = await w.post(`/biz/jobs/${J1}/applicants/reject/confirm`, []);
    expect(none.status).toBe(400);
    expect(await none.text()).toContain('지원자를 고르십시오');
    const many: Array<[string, string]> = Array.from({ length: 11 }, (_, i) => ['id', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]);
    for (const step of ['confirm', 'send']) {
      const r = await w.post(`/biz/jobs/${J1}/applicants/reject/${step}`, many);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('한 번에 10명까지');
    }
    for (const step of ['confirm', 'send']) {
      expect((await w.post(`/biz/jobs/${J1}/applicants/reject/${step}`, [['id', a], ['id', other]])).status).toBe(404);
      expect((await w.post(`/biz/jobs/${J9}/applicants/reject/${step}`, [['id', other]])).status).toBe(404); // 남의 공고
    }
    expect(w.mails).toHaveLength(0);
    expect([w.statusOf(a), w.statusOf(other)]).toEqual(['submitted', 'submitted']);
  });

  it('다른 기업 담당자는 모든 새 경로에서 404, 구직자·관리자는 /biz 에 닿지 않고, 관리자에게는 메일 경로가 없다', async () => {
    const w = world();
    const { a } = await three(w);
    const routes: Array<[string, Form]> = [
      [`/biz/applications/${a}/interview/compose`, { message: MSG }],
      [`/biz/applications/${a}/interview/preview`, { message: MSG }],
      [`/biz/applications/${a}/interview/send`, { message: MSG }],
      [`/biz/jobs/${J1}/applicants/reject/confirm`, [['id', a]]],
      [`/biz/jobs/${J1}/applicants/reject/send`, [['id', a]]],
    ];
    for (const [path, form] of routes) {
      const r = await w.post(path, form, 'co3');
      expect(r.status).toBe(404);
      noStore(r);
      for (const who of ['s1', 'adm'] as const) {
        const x = await w.post(path, form, who);
        expect(x.status).toBe(403);
        noStore(x);
      }
      const anon = await w.post(path, form, null);
      expect(anon.status).toBe(302);
      noStore(anon);
    }
    for (const path of [`/admin/applications/${a}/interview`, `/admin/applications/${a}/interview/send`, `/admin/applications/${a}/reject`,
      `/admin/jobs/${J1}/applicants/reject/send`, `/admin/jobs/${J1}/reject`]) {
      expect((await w.post(path, { message: MSG, id: a }, 'adm')).status).toBe(404);
    }
    // 메일 화면은 GET 으로 열리지 않는다 (글이 주소에 실리지 않게)
    expect((await w.get(`/biz/applications/${a}/interview/send?message=x`)).status).toBe(404);
    expect(w.mails).toHaveLength(0);
    expect(w.events()).toEqual([]);
  });

  it('본사 담당자: 동의 없는 지원에는 면접 요청·불합격 통보를 보낼 수 없고 체크 칸도 없다. 동의한 지원에는 보낼 수 있다', async () => {
    const w = world();
    const { a, b } = await three(w); // a: 동의 없음, b: 동의
    const list = await (await w.get(`/biz/jobs/${J1}/applicants`, 'hq1')).text();
    expect(list).not.toContain(`value="${a}"`);
    expect(list).toContain(`value="${b}"`);
    for (const step of ['preview', 'send']) {
      const r = await w.post(`/biz/applications/${a}/interview/${step}`, { message: MSG }, 'hq1');
      expect(r.status).toBe(403);
      expect(await r.text()).toContain('국외 이전');
    }
    const rj = await w.post(`/biz/jobs/${J1}/applicants/reject/send`, [['id', a]], 'hq1');
    expect(rj.status).toBe(400);
    expect(w.mails).toHaveLength(0);
    expect((await w.post(`/biz/applications/${b}/interview/send`, { message: MSG }, 'hq1')).status).toBe(303);
    expect(w.mails[0]).toMatchObject({ to: [SEEKERS.s2.email], reply_to: 'hq1@example.test' });
    expect(w.events()).toEqual([{ application_id: b, event: 'interview_mail', actor_id: 'hq1' }]);
  });

  it('중국어 화면: 쓰기·미리 보기·불합격 확인이 중국어로, 확인 화면에는 보낼 한국어 글과 중국어 참고가 함께', async () => {
    const w = world();
    const { a } = await three(w);
    const page = await (await w.get(`/biz/applications/${a}`, 'co', 'zh')).text();
    expect(page).toContain('发送面试邀请');
    expect(page).toContain('还可以发送 3 次');
    const compose = await (await w.post(`/biz/applications/${a}/interview/compose`, { message: MSG }, 'co', 'zh')).text();
    expect(compose).toContain('第 1 位应聘者');
    const pv = await (await w.post(`/biz/applications/${a}/interview/preview`, { message: MSG }, 'co', 'zh')).text();
    expect(pv).toContain('发送前确认');
    expect(pv).toContain('未能生成韩文翻译，将只发送原文。');
    const conf = await (await w.post(`/biz/jobs/${J1}/applicants/reject/confirm`, [['id', a]], 'co', 'zh')).text();
    expect(conf).toContain('确认发送未通过通知');
    expect(conf).toContain('将发送给 1 人。');
    expect(conf).toContain(esc(rejectMail({ companyName: '가짜전자', jobTitle: TITLE1 }, t).text));
    expect(conf).toContain('中文参考（不会发送）');
    expect(conf).toContain(esc(rejectMail({ companyName: '가짜전자', jobTitle: TITLE1 }, (_l, k) => t('zh', k)).text));
    for (const h of [page, compose, pv, conf]) for (const s of ['취업상담', '취업추천', '취업지원', '취업알선']) expect(h).not.toContain(s);
  });
});
