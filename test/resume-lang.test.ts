// 이력서 작성 언어 (T-22): 마이그레이션 0002 · 이력서 폼(필수 선택)·목록 표시 · 지원서 복사본의 lang · 기업 지원자 목록·지원서 화면의 표시.
// 표시만 한다 — 기업 화면에 언어로 정렬·거르는 칸이나 주소 인자가 없다. 번역하지 않는다 (규칙 6). 모든 데이터는 가짜다 (규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { buildSnapshot } from '../src/lib/application';
import { b64url, encryptText, importEncKey, sha256Hex } from '../src/lib/crypto';
import { openResume, resumeLangOf, sealResume, snapshotLang, validateResume, EMPTY_RESUME_INPUT, type ResumeBody } from '../src/lib/resume';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';
import { agreeRequired } from './consent-fixture';
import { hasDb, migratedDb } from './pg-test-db';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';
const J1 = '11111111-1111-4111-8111-111111111111';
type Who = 's1' | 's2' | 'co';

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0), ('co','co@example.test','company','active',0)`);
  raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0)");
  raw.exec("INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','co','owner',0,0)");
  raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_zh, title_ko, body_ko, contact_email, localize_status, status, published_at, created_at, updated_at, company_name_public) VALUES
    ('${J1}','c1','co','office','假销售经理','가짜 영업 매니저','본문','hr@example-corp.test','approved','published',1,0,0,1)`);
  const store = new Map<string, Uint8Array>();
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v.slice() : new Uint8Array(v)); },
    get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.slice().buffer, body: v } : null; },
    delete: async (k: string) => { store.delete(k); },
  };
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: d1, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const sessions = new Set<Who>();
  const cookie = async (who: Who, lang: string) => {
    if (!sessions.has(who)) {
      raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,0)').run(await sha256Hex(`${PEPPER}|tok-${who}`), who, 0, 4_000_000_000);
      agreeRequired(raw, who);
      sessions.add(who);
    }
    return { cookie: `sid=tok-${who}; lang=${lang}` };
  };
  const get = async (path: string, who: Who, lang = 'ko') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who, lang) }) as never, env);
  const post = async (path: string, form: FormData | Record<string, string>, who: Who) =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST', body: form instanceof FormData ? form : new URLSearchParams(form), headers: { ...(await cookie(who, 'ko')), origin: ORIGIN },
    }) as never, env);
  const one = (sql: string, ...a: unknown[]) => raw.prepare(sql).get(...(a as never[]))!;
  return { raw, env, get, post, one };
}
type World = ReturnType<typeof world>;

const FIELDS = { title: '테스트용', name: '가짜이름', chinese_level: 'business', years: '5', headline: '가짜 한 줄', contact_email: 'fake@example.test', phone: '', desired_role: '', experience_text: '가짜 경력 요약' };
const resumeForm = (extra: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...FIELDS, ...extra })) fd.set(k, v);
  fd.set('attachment', new File([], '', { type: 'application/octet-stream' }));
  return fd;
};
async function newResume(w: World, who: Who, lang: string | null, title = '테스트용'): Promise<Response> {
  return w.post('/my/resumes/new', resumeForm({ title, ...(lang === null ? {} : { lang }) }), who);
}
const lastResume = (w: World, who: Who) => w.one('SELECT id, lang FROM resumes WHERE user_id = ? ORDER BY created_at DESC, ctid DESC', who);
async function apply(w: World, who: Who, resumeId: string): Promise<string> {
  const { title: _t, ...rest } = FIELDS;
  const res = await w.post(`/jobs/${J1}/apply`, { resume_id: resumeId, ...rest }, who);
  expect(res.status).toBe(302);
  return /\/my\/applications\/([0-9a-f-]{36})\?ok=/.exec(res.headers.get('location') ?? '')![1]!;
}

describe('작성 언어: 순수 함수', () => {
  it('폼 검사: 필수, ko·zh 만', () => {
    const base = { ...EMPTY_RESUME_INPUT, ...FIELDS };
    const errs = (lang: string) => { const v = validateResume({ ...base, lang }); return v.ok ? v.lang : v.errors.map((e) => `${e.field}:${e.code}`); };
    expect(errs('ko')).toBe('ko');
    expect(errs('zh')).toBe('zh');
    expect(errs('')).toEqual(['lang:required']);
    expect(errs('en')).toEqual(['lang:invalid']);
  });
  it('복사본에 lang 이 들어가고, lang 이 없는 예전 복사본은 ko 로 읽는다', async () => {
    const key = await importEncKey(ENC_KEY);
    const base: ResumeBody = { v: 1, name: '가짜', chinese_level: 'native', years: 3, headline: 'h', contact_email: 'a@example.test', phone: null, desired_role: null, experience_text: 'x', file: null };
    const { v: _v, file: _f, ...fields } = base;
    const snap = buildSnapshot(base, fields, { include: false, copied: false }, 'zh');
    expect(snap.lang).toBe('zh');
    expect(snapshotLang(await openResume(key, await sealResume(key, snap)))).toBe('zh');
    // T-22 전에 만든 복사본 (lang 없음)
    const old = await openResume(key, await encryptText(key, JSON.stringify(base)));
    expect(old.lang).toBeUndefined();
    expect(snapshotLang(old)).toBe('ko');
    // 모르는 값은 열지 않는다 (다른 모양 검사와 같다)
    await expect(openResume(key, await encryptText(key, JSON.stringify({ ...base, lang: 'en' })))).rejects.toThrow();
    expect(resumeLangOf({ lang: 'zh' })).toBe('zh');
    expect(resumeLangOf({ lang: 'x' })).toBe('ko');
  });
  it('화면 문구가 두 언어에 있다 (금지 표현은 locales 테스트가 본다)', () => {
    for (const k of ['resume.f.lang', 'resume.lang.ko', 'resume.lang.zh', 'resume.lang.label.ko', 'resume.lang.label.zh', 'resume.hint.lang', 'resume.err.invalid.lang']) {
      expect(ko[k], k).toBeTruthy();
      expect(zh[k], k).toBeTruthy();
    }
    expect(ko['resume.lang.label.ko']).toBe('한국어 이력서');
    expect(zh['resume.lang.label.zh']).toBe('中文简历');
  });
});

describe.skipIf(!hasDb)('작성 언어: DB·화면', () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => { spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})); });
  afterEach(() => { vi.restoreAllMocks(); spies = []; });

  it('마이그레이션 0002: lang 없이 넣은 행은 ko, ko·zh 밖의 값은 거절', () => {
    const { raw } = migratedDb();
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('u1','u1@example.test','seeker',0)");
    raw.exec("INSERT INTO resumes (id, user_id, title, is_default, body, created_at, updated_at) VALUES ('r1','u1','t',1,'v1.x.y',0,0)");
    expect(raw.prepare("SELECT lang FROM resumes WHERE id = 'r1'").get()!.lang).toBe('ko');
    expect(() => raw.exec("INSERT INTO resumes (id, user_id, title, is_default, body, lang, created_at, updated_at) VALUES ('r2','u1','t',0,'v1.x.y','en',0,0)")).toThrow();
    raw.exec("INSERT INTO companies (id, name_ko, entity_type, created_at) VALUES ('c1','x','cn_hq',0)");
    raw.exec("INSERT INTO jobs (id, company_id, created_by, job_family, status, created_at, updated_at) VALUES ('j1','c1','u1','office','draft',0,0)");
    raw.exec("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status_changed_at, created_at) VALUES ('a1','j1','u1','v1.x.y',0,0)");
    expect(raw.prepare("SELECT resume_lang FROM applications WHERE id = 'a1'").get()!.resume_lang).toBe('ko');
    expect(() => raw.exec("UPDATE applications SET resume_lang = 'ja' WHERE id = 'a1'")).toThrow();
  });

  it('이력서 폼: 필수 선택(한국어 / 中文), 저장·목록 표시·수정·복사', async () => {
    const w = world();
    const form = await (await w.get('/my/resumes/new', 's1')).text();
    expect(form).toMatch(/<input type="radio" name="lang" value="ko" required=""\s*\/?>/);
    expect(form).toMatch(/<input type="radio" name="lang" value="zh" required=""\s*\/?>/);
    expect(form).toContain('작성 언어 *');
    expect(form).toContain('中文');
    // 고르지 않으면·이상한 값이면 저장하지 않는다
    for (const bad of [null, 'en']) {
      const res = await newResume(w, 's1', bad);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('작성 언어');
    }
    expect(Number(w.one("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1'").n)).toBe(0);
    expect((await newResume(w, 's1', 'ko', '한국어판')).status).toBe(302);
    expect((await newResume(w, 's1', 'zh', '중국어판')).status).toBe(302);
    const zhId = String(lastResume(w, 's1').id);
    expect(lastResume(w, 's1').lang).toBe('zh');
    const list = await (await w.get('/my/resumes', 's1')).text();
    expect(list).toContain('한국어 이력서');
    expect(list).toContain('중국어 이력서');
    expect(await (await w.get('/my/resumes', 's1', 'zh')).text()).toContain('中文简历');
    // 수정 화면은 저장된 값이 골라져 있고, 바꿔 저장할 수 있다
    const edit = await (await w.get(`/my/resumes/${zhId}/edit`, 's1')).text();
    expect(edit).toMatch(/value="zh" required="" checked=""/);
    const updatedAt = String(w.one('SELECT updated_at FROM resumes WHERE id = ?', zhId).updated_at);
    expect((await w.post(`/my/resumes/${zhId}/edit`, resumeForm({ title: '중국어판', lang: 'ko', updated_at: updatedAt }), 's1')).status).toBe(302);
    expect(w.one('SELECT lang FROM resumes WHERE id = ?', zhId).lang).toBe('ko');
    expect((await w.post(`/my/resumes/${zhId}/edit`, resumeForm({ title: '중국어판', lang: 'zh', updated_at: String(Number(updatedAt) + 1) }), 's1')).status).toBe(302);
    // 복사본은 같은 언어
    expect((await w.post(`/my/resumes/${zhId}/copy`, {}, 's1')).status).toBe(302);
    expect(lastResume(w, 's1').lang).toBe('zh');
    // 본문은 그대로 암호문, lang 은 평문 컬럼
    for (const r of w.raw.prepare("SELECT body FROM resumes WHERE user_id = 's1'").all()) expect(String(r.body).startsWith('v1.')).toBe(true);
  });

  it('지원: 고른 이력서의 언어가 복사본과 지원 행에 남고, 기업 목록·지원서 화면에 표시만 된다 (정렬·거르기 없음)', async () => {
    const w = world();
    expect((await newResume(w, 's1', 'zh')).status).toBe(302);
    const r1 = String(lastResume(w, 's1').id);
    expect((await newResume(w, 's2', 'ko')).status).toBe(302);
    const r2 = String(lastResume(w, 's2').id);
    // 지원 1단계 목록에 언어 표시
    expect(await (await w.get(`/jobs/${J1}/apply`, 's1')).text()).toContain('중국어 이력서');
    const a1 = await apply(w, 's1', r1);
    const a2 = await apply(w, 's2', r2);
    w.raw.prepare('UPDATE applications SET created_at = created_at + 10 WHERE id = ?').run(a2);
    expect(w.one('SELECT resume_lang FROM applications WHERE id = ?', a1).resume_lang).toBe('zh');
    expect(w.one('SELECT resume_lang FROM applications WHERE id = ?', a2).resume_lang).toBe('ko');
    const key = await importEncKey(ENC_KEY);
    expect(snapshotLang(await openResume(key, String(w.one('SELECT resume_snapshot FROM applications WHERE id = ?', a1).resume_snapshot)))).toBe('zh');

    // 기업 목록: 두 표시, 지원한 순서 그대로, 언어로 정렬·거르는 칸·링크 없음, 목록을 보는 것은 열람이 아니다
    const before = Number(w.one('SELECT COUNT(*) AS n FROM access_log').n);
    const list = await (await w.get(`/biz/jobs/${J1}/applicants`, 'co')).text();
    expect(list).toContain('한국어 이력서');
    expect(list).toContain('중국어 이력서');
    expect(list.indexOf(`/biz/applications/${a1}`)).toBeLessThan(list.indexOf(`/biz/applications/${a2}`));
    expect(list).not.toMatch(/name="(lang|resume_lang|sort|order)"/);
    expect(list).not.toMatch(/[?&](lang|resume_lang|sort|order)=/);
    expect(Number(w.one('SELECT COUNT(*) AS n FROM access_log').n)).toBe(before);
    expect(w.one('SELECT status FROM applications WHERE id = ?', a1).status).toBe('submitted');
    // 같은 목록에 언어 인자를 붙여도 내용·순서가 같다 (거르기 없음)
    const filtered = await (await w.get(`/biz/jobs/${J1}/applicants?lang=zh&resume_lang=zh&sort=lang`, 'co')).text();
    expect(filtered.match(/\/biz\/applications\/[0-9a-f-]{36}"/g)).toEqual(list.match(/\/biz\/applications\/[0-9a-f-]{36}"/g));
    const zhList = await (await w.get(`/biz/jobs/${J1}/applicants`, 'co', 'zh')).text();
    expect(zhList).toContain('中文简历');
    expect(zhList).toContain('韩文简历');

    // 지원서 화면
    expect(await (await w.get(`/biz/applications/${a1}`, 'co')).text()).toContain('중국어 이력서');
    expect(await (await w.get(`/biz/applications/${a2}`, 'co', 'zh')).text()).toContain('韩文简历');
    // 구직자 본인 화면
    expect(await (await w.get(`/my/applications/${a1}`, 's1')).text()).toContain('중국어 이력서');
  });
});
