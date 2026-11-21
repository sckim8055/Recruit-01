// 지원 화면 (/jobs/:id/apply, /my/applications...) — app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts) + Map 으로 만든 가짜 R2.
// 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { CROSS_BORDER_VERSION } from '../src/lib/application';
import { b64url, importEncKey, sha256Hex } from '../src/lib/crypto';
import { openResume } from '../src/lib/resume';
import { hasSqlite, migratedDb } from './sqlite-d1';

const te = new TextEncoder();
const ENC_KEY = b64url(new Uint8Array(32).fill(5)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';

// 가짜 이름·연락처·내용 (로그·메일·저장소 평문에 나오면 안 되는 값)
const NAME = '가짜지원자이름';
const EMAIL = 'fake.applicant@example.test';
const PHONE = '010-9999-8888';
const HEADLINE = '원래한줄소개';
const EDITED = '이번지원전용한줄';
const SECRET_IN_FILE = 'SECRET-APPLY-FILE-777';
const pdf = te.encode(`%PDF-1.4\n% ${SECRET_IN_FILE}\n1 0 obj\n<<>>\nendobj\n%%EOF`);

const J1 = '11111111-1111-4111-8111-111111111111'; // c1: 한국 담당자 + 본사 담당자 → 동의 선택
const J2 = '22222222-2222-4222-8222-222222222222'; // c2: 본사 담당자만 → 동의 필수
const J3 = '33333333-3333-4333-8333-333333333333'; // c1 초안 (보이지 않음)
const J4 = '44444444-4444-4444-8444-444444444444'; // c3: 본사 담당자 없음, 기업명 비공개 → 동의 없음
const TITLE1 = '가짜 영업 매니저';

type Who = 's1' | 's2' | 'co' | 'hq1' | 'adm';

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0),
    ('co','co@example.test','company','active',0), ('hq1','hq1@example.test','company','active',0),
    ('hq2','hq2@example.test','company','active',0), ('sus','sus@example.test','company','suspended',0),
    ('co3','co3@example.test','company','active',0), ('adm','adm@example.test','admin','active',0)`);
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES
    ('c1','가짜전자','kr_entity','verified',0), ('c2','가짜본사','cn_hq','verified',0), ('c3','숨은기업','kr_entity','verified',0)`);
  raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES
    ('c1','co','owner',0,0), ('c1','hq1','member',1,0), ('c1','sus','member',0,0), ('c2','hq2','owner',1,0), ('c3','co3','owner',0,0)`);
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, contact_email, localize_status, status, published_at, created_at, updated_at, company_name_public) VALUES
    ('${J1}','c1','co','office','${TITLE1}','본문','hr@example-corp.test','approved','published',1,0,0,1),
    ('${J2}','c2','hq2','office','가짜 본사 직무','본문','hr2@example-corp.test','approved','published',1,0,0,1),
    ('${J3}','c1','co','office','초안 공고','본문','hr@example-corp.test','approved','draft',NULL,0,0,1),
    ('${J4}','c3','co3','office','비공개 기업 공고','본문','hr3@example-corp.test','approved','published',1,0,0,0)`);
  const store = new Map<string, Uint8Array>();
  const sw = { failGet: false, refuseInsert: false, failMailLog: false };
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v.slice() : new Uint8Array(v)); },
    get: async (k: string) => {
      if (sw.failGet) throw new Error('simulated R2 failure');
      const v = store.get(k);
      return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), body: v } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
  const db = {
    prepare: (sql: string) => {
      if (sw.failMailLog && sql.includes('INSERT INTO email_log')) throw new Error('simulated D1 failure');
      return d1.prepare(sql);
    },
    // 지원 INSERT 를 "들어가지 않음" 으로 만드는 스위치 (insertApplication 이 false 를 돌려주는 경우)
    batch: async (s: { sql: string }[]) => {
      if (sw.refuseInsert && s[0]?.sql.includes('INSERT INTO applications')) return s.map(() => ({ meta: { changes: 0 } }));
      return d1.batch(s as never);
    },
  } as unknown as D1Database;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const sessions = new Map<Who, string>();
  const cookie = async (who: Who | null, lang = 'ko'): Promise<Record<string, string>> => {
    if (!who) return {};
    if (!sessions.has(who)) {
      const token = `tok-${who}`;
      raw.prepare('INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
        .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
      sessions.set(who, token);
    }
    return { cookie: `sid=${sessions.get(who)}; lang=${lang}` };
  };
  const get = async (path: string, who: Who | null = 's1', lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who, lang) }) as never, env);
  const post = async (path: string, form: FormData | Record<string, string> = {}, who: Who | null = 's1') => {
    const body = form instanceof FormData ? form : new URLSearchParams(form);
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { ...(await cookie(who)), origin: ORIGIN } }) as never, env);
  };
  const apps = () => raw.prepare('SELECT * FROM applications ORDER BY created_at, rowid').all() as {
    id: string; job_id: string; seeker_id: string; resume_id: string; resume_snapshot: string; file_r2_key: string | null;
    cross_border_consent_at: number | null; status: string;
  }[];
  const resumes = (user = 's1') => raw.prepare('SELECT id, title, body, file_r2_key FROM resumes WHERE user_id = ? ORDER BY created_at, rowid').all(user) as {
    id: string; title: string; body: string; file_r2_key: string | null;
  }[];
  const count = (table: string) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  return { raw, env, store, sw, get, post, apps, resumes, count };
}
type World = ReturnType<typeof world>;

const resumeFields = (p: Record<string, string> = {}) => ({
  title: '영업직용', name: NAME, chinese_level: 'business', years: '5', headline: HEADLINE,
  contact_email: EMAIL, phone: PHONE, desired_role: '영업', experience_text: '', ...p,
});

async function createResume(w: World, p: Record<string, string> = {}, withFile = true, who: Who = 's1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(resumeFields(p))) fd.set(k, v);
  fd.set('attachment', withFile ? new File([pdf], `${NAME}.pdf`, { type: 'application/pdf' }) : new File([], '', { type: 'application/octet-stream' }));
  const res = await w.post('/my/resumes/new', fd, who);
  expect([res.status, res.headers.get('location')]).toEqual([302, '/my/resumes?ok=created']);
  return w.resumes(who).at(-1)!;
}

/** 2단계 폼에서 보낼 값 (이력서 이름표는 보내지 않는다 — 화면에 없다). */
const applyForm = (resumeId: string, p: Record<string, string> = {}) => {
  const { title: _t, ...rest } = resumeFields(p);
  return { resume_id: resumeId, include_file: '1', ...rest, ...p };
};

const appIdFrom = (res: Response) => /\/my\/applications\/([0-9a-f-]{36})\?ok=/.exec(res.headers.get('location') ?? '')?.[1];

describe.skipIf(!hasSqlite)('지원 화면', () => {
  let logSpy: ReturnType<typeof vi.spyOn>, errSpy: ReturnType<typeof vi.spyOn>, warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    // console.log 는 dev 메일 출력("[mail:new_applicant]")뿐이고, 어디에도 구직자 정보가 없다.
    for (const call of logSpy.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line.startsWith('[mail:new_applicant]')).toBe(true);
      for (const secret of [NAME, EMAIL, PHONE, HEADLINE, EDITED, SECRET_IN_FILE, 's1@example.test', 's2@example.test']) expect(line).not.toContain(secret);
    }
    // 실패를 일부러 일으키는 테스트는 자기 안에서 확인하고 spy 를 비운다.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('정상 흐름: 이력서 고르기 → 이번 지원만 고치기 → 지원 (복사본은 암호문, 원본 그대로, 파일은 새 객체, 동의 없음)', async () => {
    const w = world();
    const r = await createResume(w);
    const resumeBefore = w.resumes()[0]!;

    // 1단계: 대표 이력서가 골라져 있다
    const step1 = await w.get(`/jobs/${J1}/apply`);
    expect(step1.status).toBe(200);
    expect(step1.headers.get('cache-control')).toBe('private, no-store');
    expect(step1.headers.get('x-page-cache')).toBeNull();
    const h1 = await step1.text();
    expect(h1).toContain(`value="${r.id}" required="" checked=""`);
    expect(h1).toContain('가짜전자');

    // 2단계: 이력서 값으로 채운 폼, 이름표는 없다, 첨부 함께 보내기 기본 체크, 확인 상자, 선택 동의(체크 안 됨)
    const step2 = await w.get(`/jobs/${J1}/apply?resume=${r.id}`);
    expect(step2.headers.get('cache-control')).toBe('private, no-store');
    const h2 = await step2.text();
    expect(h2).toContain(`value="${HEADLINE}"`);
    expect(h2).not.toContain('name="title"');
    expect(h2).toContain('name="include_file" value="1" checked=""');
    expect(h2).toContain(`${NAME}.pdf`);
    expect(h2).toContain('여기서 고친 내용은 이번 지원에만 쓰이고, 저장된 이력서는 바뀌지 않습니다.');
    expect(h2).toContain(`받는 곳: 가짜전자 — 공고 &quot;${TITLE1}&quot;`);
    expect(h2).toContain('운영자는 지원서를 검토·추천·전달하지 않습니다');
    expect(h2).toContain('취소하면 지원 내용과 첨부파일이 삭제됩니다');
    expect(h2).toContain('중국 본사 담당자 열람 동의 (선택)');
    expect(h2).toMatch(/<input type="checkbox" name="consent" value="1"\/?>/);
    expect(h2).not.toContain(CROSS_BORDER_VERSION);

    const res = await w.post(`/jobs/${J1}/apply`, applyForm(r.id, { headline: EDITED }));
    expect(res.status).toBe(302);
    const id = appIdFrom(res)!;
    expect(res.headers.get('location')).toBe(`/my/applications/${id}?ok=applied`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const [a] = w.apps();
    expect(a).toMatchObject({ id, job_id: J1, seeker_id: 's1', resume_id: r.id, status: 'submitted', cross_border_consent_at: null });
    expect(a!.resume_snapshot).not.toBe(resumeBefore.body);
    for (const secret of [NAME, EMAIL, EDITED, HEADLINE]) expect(a!.resume_snapshot).not.toContain(secret);
    const snap = await openResume(await importEncKey(ENC_KEY), a!.resume_snapshot);
    expect(snap).toMatchObject({ headline: EDITED, name: NAME, file: { name: `${NAME}.pdf`, ext: 'pdf' } });
    // 원본 이력서는 그대로
    expect(w.resumes()[0]).toEqual(resumeBefore);
    expect((await openResume(await importEncKey(ENC_KEY), w.resumes()[0]!.body)).headline).toBe(HEADLINE);
    // 파일은 새 R2 객체 (암호화, RF1), 원본 객체도 남아 있다
    expect(a!.file_r2_key).toMatch(/^rfiles\//);
    expect(a!.file_r2_key).not.toBe(r.file_r2_key);
    expect(new TextDecoder('latin1').decode(w.store.get(a!.file_r2_key!)!.slice(0, 3))).toBe('RF1');
    expect(new TextDecoder('latin1').decode(w.store.get(a!.file_r2_key!)!)).not.toContain(SECRET_IN_FILE);
    expect(w.store.has(r.file_r2_key!)).toBe(true);
    // 선택 동의를 하지 않았으므로 동의 기록이 없다
    expect(w.count('consents')).toBe(0);

    // 결과 화면: 고친 내용, 동의하지 않음, 첨부 링크
    const page = await w.get(`/my/applications/${id}?ok=applied`);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    const hp = await page.text();
    expect(hp).toContain('지원했습니다.');
    expect(hp).toContain(EDITED);
    expect(hp).toContain('동의하지 않음');
    expect(hp).toContain(`/my/applications/${id}/file`);
    expect(w.count('access_log')).toBe(0); // 본인이 자기 지원서를 보는 화면은 기록하지 않는다

    // 첨부 내려받기: 올린 바이트와 같다, 기록이 남는다
    const dl = await w.get(`/my/applications/${id}/file`);
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(pdf);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(w.count('access_log')).toBe(1);

    // 기업 알림: 활성 담당자(co, hq1)에게만. 정지된 담당자(sus)는 제외. 메일에는 공고 제목과 주소뿐
    const mails = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(mails).toHaveLength(2);
    expect(mails.map((m: string) => /to=(\S+)/.exec(m)![1]).sort()).toEqual(['co@example.test', 'hq1@example.test']);
    for (const m of mails) {
      expect(m).toContain(TITLE1);
      expect(m).toContain(`${ORIGIN}/biz`);
    }
    expect(w.raw.prepare("SELECT COUNT(*) AS n FROM email_log WHERE template = 'new_applicant'").get()!.n).toBe(2);

    // 목록: 제목 링크, 상태
    const list = await (await w.get('/my/applications')).text();
    expect(list).toContain(`href="/jobs/${J1}"`);
    expect(list).toContain('지원 완료');
    expect(list).toContain(`/my/applications/${id}`);
  });

  it('선택 동의를 하면 동의가 기록된다', async () => {
    const w = world();
    const r = await createResume(w);
    const res = await w.post(`/jobs/${J1}/apply`, applyForm(r.id, { consent: '1' }));
    expect(res.status).toBe(302);
    const [a] = w.apps();
    expect(a!.cross_border_consent_at).not.toBeNull();
    expect({ ...w.raw.prepare('SELECT user_id, type, version, ref_id FROM consents').get()! })
      .toEqual({ user_id: 's1', type: 'cross_border', version: CROSS_BORDER_VERSION, ref_id: a!.id });
    expect(await (await w.get(`/my/applications/${a!.id}`)).text()).toContain('동의함');
  });

  it('동의가 필요 없는 기업: 동의 칸이 없고, 보내도 기록하지 않는다. 기업명 비공개는 중립 표시', async () => {
    const w = world();
    const r = await createResume(w);
    const h = await (await w.get(`/jobs/${J4}/apply?resume=${r.id}`)).text();
    expect(h).not.toContain('name="consent"');
    expect(h).toContain('받는 곳: 기업명 비공개');
    expect(h).not.toContain('숨은기업');
    const res = await w.post(`/jobs/${J4}/apply`, applyForm(r.id, { consent: '1' }));
    expect(res.status).toBe(302);
    expect(w.apps()[0]!.cross_border_consent_at).toBeNull();
    expect(w.count('consents')).toBe(0);
    expect(await (await w.get('/my/applications')).text()).toContain('기업명 비공개');
  });

  it('본사 담당자만 있는 기업: 동의 없이는 막히고(파일 복사 없음), 동의하면 지원된다', async () => {
    const w = world();
    const r = await createResume(w);
    const h = await (await w.get(`/jobs/${J2}/apply?resume=${r.id}`)).text();
    expect(h).toContain('중국 본사 담당자 열람 동의 (필수)');
    expect(h).toMatch(/name="consent" value="1" required=""/);
    const objects = w.store.size;

    const bad = await w.post(`/jobs/${J2}/apply`, applyForm(r.id, { headline: EDITED }));
    expect(bad.status).toBe(400);
    const hb = await bad.text();
    expect(hb).toContain('중국 본사 담당자 열람에 동의해야 합니다');
    expect(hb).toContain(`value="${EDITED}"`); // 입력값 유지
    expect(w.apps()).toHaveLength(0);
    expect(w.store.size).toBe(objects);

    const ok = await w.post(`/jobs/${J2}/apply`, applyForm(r.id, { consent: '1' }));
    expect(ok.status).toBe(302);
    expect(w.apps()[0]!.cross_border_consent_at).not.toBeNull();
    expect(w.count('consents')).toBe(1);
    expect(w.store.size).toBe(objects + 1);
  });

  it('같은 공고에 두 번: 지원 화면·제출 모두 기존 지원으로 보낸다 (파일 복사 없음)', async () => {
    const w = world();
    const r = await createResume(w);
    const id = appIdFrom(await w.post(`/jobs/${J1}/apply`, applyForm(r.id)))!;
    const objects = w.store.size;
    const g = await w.get(`/jobs/${J1}/apply`);
    expect([g.status, g.headers.get('location')]).toEqual([302, `/my/applications/${id}`]);
    expect(g.headers.get('cache-control')).toBe('private, no-store');
    const p = await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    expect([p.status, p.headers.get('location')]).toEqual([302, `/my/applications/${id}`]);
    expect(w.apps()).toHaveLength(1);
    expect(w.store.size).toBe(objects);
    // 공고 상세: 로그인한 구직자에게만 "이미 지원했습니다"
    const detail = await (await w.get(`/jobs/${J1}`)).text();
    expect(detail).toContain('이미 지원했습니다');
    expect(detail).not.toContain(`/jobs/${J1}/apply`);
  });

  it('구직자가 아니면: 비로그인 → 로그인, 기업·관리자 → 403 (모두 no-store)', async () => {
    const w = world();
    const anon = await w.get(`/jobs/${J1}/apply`, null);
    expect([anon.status, anon.headers.get('location')]).toEqual([302, '/login']);
    expect(anon.headers.get('cache-control')).toBe('private, no-store');
    for (const who of ['co', 'adm'] as const) {
      const g = await w.get(`/jobs/${J1}/apply`, who);
      expect(g.status).toBe(403);
      expect(g.headers.get('cache-control')).toBe('private, no-store');
      expect((await w.post(`/jobs/${J1}/apply`, { resume_id: 'x' }, who)).status).toBe(403);
      expect((await w.get('/my/applications', who)).status).toBe(403);
    }
    expect((await w.post(`/jobs/${J1}/apply`, { resume_id: 'x' }, null)).status).toBe(302);
    expect(w.apps()).toHaveLength(0);
  });

  it('보이지 않는 공고·잘못된 id·남의 이력서는 404', async () => {
    const w = world();
    const r = await createResume(w);
    const other = await createResume(w, {}, true, 's2');
    expect((await w.get(`/jobs/${J3}/apply`)).status).toBe(404);
    expect((await w.post(`/jobs/${J3}/apply`, applyForm(r.id))).status).toBe(404);
    expect((await w.get('/jobs/not-a-uuid/apply')).status).toBe(404);
    expect((await w.get(`/jobs/${J1}/apply?resume=${other.id}`)).status).toBe(404);
    expect((await w.post(`/jobs/${J1}/apply`, applyForm(other.id))).status).toBe(404);
    expect(w.apps()).toHaveLength(0);
  });

  it('지원할 수 있는 이력서가 없으면 안내, 첨부를 빼서 내용이 부족해지면 막는다', async () => {
    const w = world();
    // 이력서가 하나도 없음
    expect(await (await w.get(`/jobs/${J1}/apply`)).text()).toContain('href="/my/resumes/new"');
    // 첨부도 경력 요약도 없는 이력서
    const bare = await createResume(w, {}, false);
    const h = await (await w.get(`/jobs/${J1}/apply`)).text();
    expect(h).toContain('첨부파일이나 경력 요약이 있는 이력서가 필요합니다');
    expect(h).toContain('href="/my/resumes"');
    expect(await (await w.get(`/jobs/${J1}/apply?resume=${bare.id}`)).text()).toContain('이력서가 필요합니다'); // 고를 수 있는 이력서가 없으면 안내 화면
    const p = await w.post(`/jobs/${J1}/apply`, applyForm(bare.id));
    expect(p.status).toBe(400);
    expect(await p.text()).toContain('첨부파일이나 경력 요약 중 하나가 있어야 합니다');
    // 첨부가 있는 이력서에서 "함께 보내기" 를 끄면 (경력 요약 없음) 막힌다. 파일 복사도 하지 않는다
    const r = await createResume(w);
    const objects = w.store.size;
    const { include_file: _i, ...noFile } = applyForm(r.id);
    const q = await w.post(`/jobs/${J1}/apply`, noFile);
    expect(q.status).toBe(400);
    expect(w.store.size).toBe(objects);
    // 1단계에는 두 이력서가 보이고, 지원할 수 없는 것은 고를 수 없다
    const h1 = await (await w.get(`/jobs/${J1}/apply`)).text();
    expect(h1).toContain(`value="${bare.id}" required="" disabled=""`);
    expect(h1).toContain(`value="${r.id}" required="" checked=""`);
    const wrong = await w.get(`/jobs/${J1}/apply?resume=${bare.id}`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('고른 이력서로는 지원할 수 없습니다');
    // 경력 요약을 적으면 첨부 없이도 된다
    const ok = await w.post(`/jobs/${J1}/apply`, { ...noFile, experience_text: '가짜 경력 요약' });
    expect(ok.status).toBe(302);
    expect(w.apps()[0]!.file_r2_key).toBeNull();
    expect(w.store.size).toBe(objects);
  });

  it('항목 검사 실패는 400 + 입력값 유지', async () => {
    const w = world();
    const r = await createResume(w);
    const res = await w.post(`/jobs/${J1}/apply`, applyForm(r.id, { contact_email: 'not-an-email', headline: EDITED }));
    expect(res.status).toBe(400);
    const h = await res.text();
    expect(h).toContain('이메일 주소 형식을 확인해 주세요');
    expect(h).toContain(`value="${EDITED}"`);
    expect(w.apps()).toHaveLength(0);
  });

  it('저장이 거절되면 복사한 파일을 지우고 안내한다', async () => {
    const w = world();
    const r = await createResume(w);
    const before = new Set(w.store.keys());
    w.sw.refuseInsert = true;
    const res = await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('방금 마감되었거나');
    expect(new Set(w.store.keys())).toEqual(before);
    expect(w.apps()).toHaveLength(0);
    expect(w.count('email_log')).toBe(0); // 알림도 없다
  });

  it('첨부 복사 실패: 경력 요약이 있으면 첨부 없이 내고 알린다, 없으면 막는다', async () => {
    const w = world();
    const r = await createResume(w);
    w.sw.failGet = true;
    const blocked = await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain('첨부파일을 읽지 못해');
    expect(w.apps()).toHaveLength(0);
    const ok = await w.post(`/jobs/${J1}/apply`, applyForm(r.id, { experience_text: '가짜 경력 요약' }));
    expect(ok.headers.get('location')).toMatch(/\?ok=applied_nofile$/);
    w.sw.failGet = false;
    const a = w.apps()[0]!;
    expect(a.file_r2_key).toBeNull();
    expect((await openResume(await importEncKey(ENC_KEY), a.resume_snapshot)).file).toBeNull();
    expect(await (await w.get(ok.headers.get('location')!)).text()).toContain('첨부파일 없이 제출되었습니다');
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(['apply: file copy failed', 'apply: file copy failed']);
    errSpy.mockClear();
  });

  it('알림 메일이 실패해도 지원은 된다 (구직자에게 오류 없음, 일반 문구만 기록)', async () => {
    const w = world();
    const r = await createResume(w);
    w.sw.failMailLog = true;
    const res = await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\?ok=applied$/);
    expect(w.apps()).toHaveLength(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(['apply: notify failed', 'apply: notify failed']);
    errSpy.mockClear();
  });

  it('다른 구직자는 지원서·첨부·취소 모두 404', async () => {
    const w = world();
    const r = await createResume(w);
    const id = appIdFrom(await w.post(`/jobs/${J1}/apply`, applyForm(r.id)))!;
    for (const path of [`/my/applications/${id}`, `/my/applications/${id}/file`, `/my/applications/${id}/withdraw`]) {
      const res = await w.get(path, 's2');
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await w.post(`/my/applications/${id}/withdraw`, {}, 's2')).status).toBe(404);
    expect(w.apps()[0]!.status).toBe('submitted');
    expect(await (await w.get('/my/applications', 's2')).text()).toContain('아직 지원한 공고가 없습니다');
    // 기업 담당자도 이 화면으로는 볼 수 없다 (기업 쪽 화면은 T-09)
    expect((await w.get(`/my/applications/${id}`, 'co')).status).toBe(403);
  });

  it('취소: 확인 화면 → 내용·파일 삭제, 이벤트, 동의 철회, 두 번째 취소 거부, 다시 지원 불가', async () => {
    const w = world();
    const r = await createResume(w);
    const id = appIdFrom(await w.post(`/jobs/${J1}/apply`, applyForm(r.id, { consent: '1' })))!;
    const key = w.apps()[0]!.file_r2_key!;
    expect(w.store.has(key)).toBe(true);

    const confirm = await w.get(`/my/applications/${id}/withdraw`);
    expect(confirm.headers.get('cache-control')).toBe('private, no-store');
    const hc = await confirm.text();
    expect(hc).toContain('지원 내용과 첨부파일을 바로 삭제합니다');
    expect(hc).toContain('같은 공고에는 다시 지원할 수 없습니다');
    expect(hc).toContain(`action="/my/applications/${id}/withdraw"`);
    expect(w.apps()[0]!.status).toBe('submitted'); // GET 은 아무것도 바꾸지 않는다

    const res = await w.post(`/my/applications/${id}/withdraw`);
    expect([res.status, res.headers.get('location')]).toEqual([302, `/my/applications/${id}?ok=withdrawn`]);
    expect(w.apps()[0]).toMatchObject({ status: 'withdrawn', resume_snapshot: '', file_r2_key: null });
    expect(w.store.has(key)).toBe(false);
    expect(w.store.has(r.file_r2_key!)).toBe(true); // 이력서 원본 파일은 그대로
    expect({ ...w.raw.prepare('SELECT application_id, event, actor_id FROM application_events').get()! }).toEqual({ application_id: id, event: 'withdrawn', actor_id: 's1' });
    expect(w.raw.prepare('SELECT withdrawn_at FROM consents').get()!.withdrawn_at).not.toBeNull();

    const page = await (await w.get(`/my/applications/${id}?ok=withdrawn`)).text();
    expect(page).toContain('지원을 취소해 내용이 삭제되었습니다');
    expect(page).toContain('지원 취소함');
    expect(page).not.toContain(NAME);
    expect(page).not.toContain(`/my/applications/${id}/withdraw`);
    expect((await w.get(`/my/applications/${id}/file`)).status).toBe(404);

    const again = await w.post(`/my/applications/${id}/withdraw`);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('취소할 수 없습니다');
    expect((await w.get(`/my/applications/${id}/withdraw`)).status).toBe(400);
    expect(w.count('application_events')).toBe(1);

    // 다시 지원할 수 없다: 지원 화면은 취소한 지원으로 보낸다
    const g = await w.get(`/jobs/${J1}/apply`);
    expect([g.status, g.headers.get('location')]).toEqual([302, `/my/applications/${id}`]);
    const p = await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    expect([p.status, p.headers.get('location')]).toEqual([302, `/my/applications/${id}`]);
    expect(w.apps()).toHaveLength(1);
  });

  it('공고가 내려가면 목록에서 링크 없이 제목만, 상태 이름은 중국어 화면도 있다', async () => {
    const w = world();
    const r = await createResume(w);
    await w.post(`/jobs/${J1}/apply`, applyForm(r.id));
    w.raw.exec(`UPDATE jobs SET status = 'closed' WHERE id = '${J1}'`);
    const h = await (await w.get('/my/applications')).text();
    expect(h).toContain(TITLE1);
    expect(h).not.toContain(`href="/jobs/${J1}"`);
    expect(await (await w.get('/my/applications', 's1', 'zh')).text()).toContain('已申请');
    // 머리글·마이페이지·이력서 화면에서 지원 현황으로 가는 링크
    expect(await (await w.get('/my')).text()).toContain('href="/my/applications"');
    expect(await (await w.get('/my/resumes')).text()).toContain('href="/my/applications"');
  });

  it('공고 상세: 비로그인 화면은 누구에게나 같고 지원 링크가 있다, 기업 계정에는 지원 버튼이 없다', async () => {
    const w = world();
    const a = await w.get(`/jobs/${J1}`, null);
    const b = await w.get(`/jobs/${J1}`, null);
    const ha = await a.text();
    expect(ha).toBe(await b.text());
    expect(ha).toContain(`href="/jobs/${J1}/apply"`);
    expect(ha).toContain('href="mailto:hr@example-corp.test"');
    expect(a.headers.get('cache-control')).toBe('public, max-age=60');
    const co = await w.get(`/jobs/${J1}`, 'co');
    expect(co.headers.get('cache-control')).toBe('private, no-store');
    const hc = await co.text();
    expect(hc).not.toContain(`/jobs/${J1}/apply`);
    expect(hc).toContain('구직자 계정으로만 지원할 수 있습니다');
    // 로그인한 구직자(아직 지원 안 함)는 지원 링크
    expect(await (await w.get(`/jobs/${J1}`)).text()).toContain(`href="/jobs/${J1}/apply"`);
  });
});
