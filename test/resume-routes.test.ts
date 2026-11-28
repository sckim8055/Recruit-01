// 이력서 화면 (/my/resumes...) — app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts) + Map 으로 만든 가짜 R2.
// 모든 데이터는 가짜다 (CLAUDE.md 규칙 10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { RESUME_FILE_MAX_BYTES } from '../src/lib/resume-files';
import { agreeRequired } from './consent-fixture';
import { hasDb, migratedDb } from './pg-test-db';
import type { Db } from '../src/db/types';

const te = new TextEncoder();
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const ENC_KEY = b64url(new Uint8Array(32).fill(9)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper';
const ORIGIN = 'http://localhost';

// 가짜 이름·연락처·파일 내용 (저장소에 평문으로 나오면 안 되는 값)
const NAME = '가짜이름테스트';
const EMAIL = 'fake.seeker@example.test';
const SECRET_IN_FILE = 'SECRET-FILE-CONTENT-12345';
const pdf = (marker = SECRET_IN_FILE) => te.encode(`%PDF-1.4\n% ${marker}\n1 0 obj\n<<>>\nendobj\n%%EOF`);
const docx = () => {
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const tail = te.encode(`PK\u0001\u0002....word/document.xml....${SECRET_IN_FILE}PK\u0005\u0006`);
  const out = new Uint8Array(head.length + 100 + tail.length);
  out.set(head, 0); out.set(tail, head.length + 100);
  return out;
};

type Who = 's1' | 's2' | 'co' | 'adm';

function world() {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, created_at) VALUES
    ('s1','s1@example.test','seeker',0), ('s2','s2@example.test','seeker',0),
    ('co','co@example.test','company',0), ('adm','adm@example.test','admin',0)`);
  const store = new Map<string, Uint8Array>();
  let failUpdate = false;
  const FILES = {
    put: async (k: string, v: Uint8Array | ArrayBuffer) => { store.set(k, v instanceof Uint8Array ? v.slice() : new Uint8Array(v)); },
    get: async (k: string) => {
      const v = store.get(k);
      return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), body: v } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
  // UPDATE resumes 를 실패시키는 스위치 (DB 쓰기 예외 때 파일 정리 확인용)
  const db = {
    prepare: (sql: string) => {
      if (failUpdate && sql.startsWith('UPDATE resumes SET title')) throw new Error('simulated D1 failure');
      return d1.prepare(sql);
    },
    batch: (s: never) => d1.batch(s),
  } as unknown as Db;
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: db, FILES, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const sessions = new Map<Who, string>();
  const login = async (who: Who) => {
    const token = `tok-${who}`;
    const id = await sha256Hex(`${PEPPER}|${token}`);
    raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id, who, 0, 4_000_000_000, who === 'adm' ? 1 : 0);
    agreeRequired(raw, who); // T-11 동의 확인을 통과하게 (test/consent-fixture.ts)
    sessions.set(who, token);
  };
  const cookie = async (who: Who | null): Promise<Record<string, string>> => {
    if (!who) return {} as Record<string, string>;
    if (!sessions.has(who)) await login(who);
    return { cookie: `sid=${sessions.get(who)}; lang=ko` };
  };
  const get = async (path: string, who: Who | null = 's1') =>
    app.fetch(new Request(`${ORIGIN}${path}`, { headers: await cookie(who) }) as never, env);
  const post = async (path: string, form: FormData | Record<string, string> = {}, who: Who | null = 's1', extra: Record<string, string> = {}) => {
    const body = form instanceof FormData ? form : new URLSearchParams(form);
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { ...(await cookie(who)), origin: ORIGIN, ...extra } }) as never, env);
  };
  const rows = (user = 's1') =>
    raw.prepare('SELECT id, title, is_default, body, file_r2_key, updated_at FROM resumes WHERE user_id = ? ORDER BY created_at, ctid').all(user) as {
      id: string; title: string; is_default: number; body: string; file_r2_key: string | null; updated_at: number;
    }[];
  return { raw, env, store, get, post, rows, setFailUpdate: (v: boolean) => { failUpdate = v; } };
}
type World = ReturnType<typeof world>;

const fields = (p: Record<string, string> = {}) => ({
  title: '영업직용', lang: 'ko', name: NAME, chinese_level: 'business', years: '5', headline: '중국 본사와 일해 본 B2B 영업',
  contact_email: EMAIL, phone: '010-0000-0000', desired_role: '영업', experience_text: '', ...p,
});
function form(p: Record<string, string> = {}, file?: { bytes: Uint8Array; name: string; type?: string }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields(p))) fd.set(k, v);
  if (file) fd.set('attachment', new File([file.bytes as Uint8Array<ArrayBuffer>], file.name, { type: file.type ?? 'application/octet-stream' }));
  else fd.set('attachment', new File([], '', { type: 'application/octet-stream' })); // 브라우저가 빈 파일 칸을 보내는 모양
  return fd;
}
const create = async (w: World, p: Record<string, string> = {}, file?: { bytes: Uint8Array; name: string }) => {
  const res = await w.post('/my/resumes/new', form(p, file));
  expect([res.status, res.headers.get('location')]).toEqual([302, '/my/resumes?ok=created']);
  return w.rows().at(-1)!;
};
const editForm = (w: World, id: string, p: Record<string, string> = {}, file?: { bytes: Uint8Array; name: string }, updatedAt?: number) => {
  const fd = form(p, file);
  fd.set('updated_at', String(updatedAt ?? w.rows().find((r) => r.id === id)!.updated_at));
  return fd;
};
const download = async (w: World, id: string, who: Who = 's1') => {
  const res = await w.get(`/my/resumes/${id}/file`, who);
  return { res, bytes: res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null };
};

describe.skipIf(!hasDb)('이력서 화면', () => {
  let logSpy: ReturnType<typeof vi.spyOn>, errSpy: ReturnType<typeof vi.spyOn>, warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    // 이력서 화면은 정상 흐름에서 console 에 아무것도 쓰지 않는다 (개인정보가 로그에 남지 않게).
    // 예외를 일부러 일으키는 테스트는 자기 안에서 확인하고 spy 를 비운다.
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('빈 목록 → 만들기: 첫 이력서가 대표, 저장소에는 암호문만', async () => {
    const w = world();
    const empty = await w.get('/my/resumes');
    expect(empty.status).toBe(200);
    expect(empty.headers.get('cache-control')).toBe('private, no-store');
    expect(await empty.text()).toContain('아직 저장한 이력서가 없습니다');

    const newPage = await w.get('/my/resumes/new');
    const html = await newPage.text();
    expect(html).toContain('value="s1@example.test"'); // 연락 이메일 기본값 = 계정 이메일
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('기업에는 보이지 않습니다');

    const r = await create(w, {}, { bytes: pdf(), name: `${NAME} 이력서.pdf` });
    expect(r.is_default).toBe(1);
    expect(r.title).toBe('영업직용');
    expect(r.file_r2_key).toMatch(/^rfiles\//);
    for (const s of [NAME, EMAIL, '010-0000', '이력서.pdf', 'business']) expect(r.body).not.toContain(s);
    const stored = w.store.get(r.file_r2_key!)!;
    expect(latin1(stored).startsWith('%PDF')).toBe(false);
    expect(latin1(stored)).not.toContain(SECRET_IN_FILE);

    const list = await (await w.get('/my/resumes?ok=created')).text();
    expect(list).toContain('이력서를 저장했습니다');
    expect(list).toContain('대표');
    expect(list).toContain(`${NAME} 이력서.pdf`);
    expect(list).toContain(`/my/resumes/${r.id}/file`);
    expect(list).not.toContain(`/my/resumes/${r.id}/default`); // 대표에는 "대표로 지정" 없음

    // 내려받기: 올린 바이트 그대로, 열람 기록
    const d = await download(w, r.id);
    expect(d.res.status).toBe(200);
    expect(d.bytes).toEqual(pdf());
    expect(d.res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(d.res.headers.get('cache-control')).toBe('private, no-store');
    expect(w.raw.prepare("SELECT actor_id, target_type, target_id FROM access_log").all()).toEqual([{ actor_id: 's1', target_type: 'resume', target_id: r.id }]);

    // 두 번째는 대표가 아니다. 경력 요약도 첨부도 없으면 "지원하려면…" 안내
    const r2 = await create(w, { title: '두번째' });
    expect(r2.is_default).toBe(0);
    expect(r2.file_r2_key).toBeNull();
    const list2 = await (await w.get('/my/resumes')).text();
    expect(list2).toContain('지원하려면 첨부파일이나 경력 요약이 필요합니다');
    expect(list2).toContain(`/my/resumes/${r2.id}/default`);
  });

  it('5개 한도: 6번째는 거절되고 파일도 남지 않는다', async () => {
    const w = world();
    for (let i = 1; i <= 5; i++) await create(w, { title: `t${i}` });
    const list = await (await w.get('/my/resumes')).text();
    expect(list).toContain('5개까지 저장할 수 있습니다');
    expect(list).not.toContain('href="/my/resumes/new"');
    const g = await w.get('/my/resumes/new');
    expect([g.status, g.headers.get('location')]).toEqual([302, '/my/resumes?err=limit']);
    const p = await w.post('/my/resumes/new', form({ title: 't6' }, { bytes: pdf(), name: 'a.pdf' }));
    expect([p.status, p.headers.get('location')]).toEqual([302, '/my/resumes?err=limit']);
    expect(w.rows()).toHaveLength(5);
    expect(w.store.size).toBe(0);
    const c = await w.post(`/my/resumes/${w.rows()[0]!.id}/copy`);
    expect(c.headers.get('location')).toBe('/my/resumes?err=limit');
    expect(w.rows()).toHaveLength(5);
  });

  it('잘못된 파일·너무 큰 파일: 입력값을 그대로 두고, 저장소에 아무것도 남지 않는다', async () => {
    const w = world();
    const exe = await w.post('/my/resumes/new', form({ title: '남길제목' }, { bytes: te.encode('MZ\u0090\u0000 fake exe'), name: 'resume.pdf', type: 'application/pdf' }));
    expect(exe.status).toBe(400);
    const html = await exe.text();
    expect(html).toContain('PDF 또는 DOCX 파일만');
    expect(html).toContain('value="남길제목"');
    expect(html).toContain(`value="${NAME}"`);
    expect(html).toContain('파일을 다시 골라');
    const big = new Uint8Array(RESUME_FILE_MAX_BYTES + 1); big.set(te.encode('%PDF-1.4'), 0);
    const tooBig = await w.post('/my/resumes/new', form({}, { bytes: big, name: 'big.pdf' }));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.text()).toContain('5MB를 넘습니다');
    // 항목 오류 + 정상 파일: 파일을 올리지 않는다
    const bad = await w.post('/my/resumes/new', form({ name: '', years: '99' }, { bytes: pdf(), name: 'ok.pdf' }));
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain('이름: 입력해 주세요');
    expect(badHtml).toContain('0부터 60까지');
    expect(w.rows()).toHaveLength(0);
    expect(w.store.size).toBe(0);
  });

  it('본문이 한도(6MB)를 넘으면 읽지 않고 413', async () => {
    const w = world();
    const res = await w.post('/my/resumes/new', form(), 's1', { 'content-length': String(7 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toContain('5MB');
    expect(w.rows()).toHaveLength(0);
  });

  it('수정: 파일 유지 · 교체(예전 객체 삭제) · 삭제', async () => {
    const w = world();
    const r = await create(w, {}, { bytes: pdf('v1'), name: 'one.pdf' });
    const k1 = r.file_r2_key!;
    const page = await (await w.get(`/my/resumes/${r.id}/edit`)).text();
    expect(page).toContain('one.pdf');
    expect(page).toContain('name="remove_file"');
    expect(page).toContain(`name="updated_at" value="${r.updated_at}"`);

    // 유지: 파일 칸을 비우고 저장
    let res = await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id, { headline: '바뀐 소개' }));
    expect(res.headers.get('location')).toBe('/my/resumes?ok=saved');
    expect(w.rows()[0]!.file_r2_key).toBe(k1);
    expect([...w.store.keys()]).toEqual([k1]);
    expect(await (await w.get('/my/resumes')).text()).toContain('바뀐 소개');

    // 교체: 새 DOCX → 새 키, 예전 객체는 DB 갱신 뒤 삭제
    res = await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id, {}, { bytes: docx(), name: 'two.docx' }));
    expect(res.headers.get('location')).toBe('/my/resumes?ok=saved');
    const k2 = w.rows()[0]!.file_r2_key!;
    expect(k2).not.toBe(k1);
    expect([...w.store.keys()]).toEqual([k2]);
    const d = await download(w, r.id);
    expect(d.bytes).toEqual(docx());
    expect(d.res.headers.get('content-type')).toContain('wordprocessingml');

    // 삭제 체크
    const fd = editForm(w, r.id);
    fd.set('remove_file', '1');
    res = await w.post(`/my/resumes/${r.id}/edit`, fd);
    expect(res.headers.get('location')).toBe('/my/resumes?ok=saved');
    expect(w.rows()[0]!.file_r2_key).toBeNull();
    expect(w.store.size).toBe(0);
    expect((await download(w, r.id)).res.status).toBe(404);
  });

  it('다른 창에서 먼저 고쳤으면(stale): 안내 + 입력값 유지, 새 파일은 지우고 예전 파일은 그대로', async () => {
    const w = world();
    const r = await create(w, {}, { bytes: pdf(), name: 'one.pdf' });
    const k1 = r.file_r2_key!;
    const staleAt = r.updated_at;
    // 다른 창에서 저장
    expect((await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id, { headline: '다른 창' }))).status).toBe(302);
    // 예전 화면에서 새 파일과 함께 저장
    const res = await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id, { headline: '내 입력' }, { bytes: docx(), name: 'new.docx' }, staleAt));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('다른 창에서 이력서가 바뀌었습니다');
    expect(html).toContain('value="내 입력"');
    const now = w.rows()[0]!;
    expect(html).toContain(`name="updated_at" value="${now.updated_at}"`); // 다시 저장할 수 있게 지금 버전
    expect(now.file_r2_key).toBe(k1);
    expect([...w.store.keys()]).toEqual([k1]);
  });

  it('DB 쓰기가 실패하면 방금 올린 파일만 지우고 예전 파일은 남긴다', async () => {
    const w = world();
    const r = await create(w, {}, { bytes: pdf(), name: 'one.pdf' });
    const k1 = r.file_r2_key!;
    w.setFailUpdate(true);
    const res = await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id, {}, { bytes: docx(), name: 'two.docx' }));
    expect(res.status).toBe(500);
    expect([...w.store.keys()]).toEqual([k1]);
    expect(w.rows()[0]!.file_r2_key).toBe(k1);
    // 오류 로그는 일반 메시지만 (이름·파일명 없음)
    const logged = JSON.stringify(errSpy.mock.calls);
    for (const s of [NAME, EMAIL, 'two.docx', 'one.pdf']) expect(logged).not.toContain(s);
    errSpy.mockClear();
  });

  it('복사: 같은 내용, 첨부파일은 새 객체로', async () => {
    const w = world();
    const r = await create(w, { title: '원본' }, { bytes: pdf(), name: 'one.pdf' });
    const res = await w.post(`/my/resumes/${r.id}/copy`);
    expect(res.headers.get('location')).toBe('/my/resumes?ok=copied');
    const [a, b] = w.rows();
    expect(b!.title).toBe('원본 (복사)');
    expect(b!.is_default).toBe(0);
    expect(b!.file_r2_key).not.toBe(a!.file_r2_key);
    expect(w.store.size).toBe(2);
    expect((await download(w, b!.id)).bytes).toEqual(pdf());
    // 중국어 화면에서는 (副本)
    const zh = await app.fetch(new Request(`${ORIGIN}/my/resumes/${r.id}/copy`, {
      method: 'POST', headers: { cookie: 'sid=tok-s1; lang=zh', origin: ORIGIN },
    }) as never, w.env);
    expect(zh.status).toBe(302);
    expect(w.rows()[2]!.title).toBe('원본 (副本)');
    // 원본 파일이 사라졌으면 첨부 없이 복사하고 알려 준다
    w.store.delete(a!.file_r2_key!);
    const lost = await w.post(`/my/resumes/${r.id}/copy`);
    expect(lost.headers.get('location')).toBe('/my/resumes?ok=copied_nofile');
    expect(w.rows()[3]!.file_r2_key).toBeNull();
    expect((await (await w.get(`/my/resumes/${w.rows()[3]!.id}/edit`)).text())).not.toContain('one.pdf');
  });

  it('대표 지정과 삭제: 대표를 지우면 다른 것이 대표가 되고 객체도 지워진다', async () => {
    const w = world();
    const a = await create(w, { title: 'A' }, { bytes: pdf(), name: 'a.pdf' });
    const b = await create(w, { title: 'B' }, { bytes: docx(), name: 'b.docx' });
    expect((await w.post(`/my/resumes/${b.id}/default`)).headers.get('location')).toBe('/my/resumes?ok=default');
    expect(w.rows().map((r) => [r.title, r.is_default])).toEqual([['A', 0], ['B', 1]]);
    const list = await (await w.get('/my/resumes')).text();
    expect(list.indexOf('>B<')).toBeLessThan(list.indexOf('>A<')); // 대표가 맨 위

    const confirm = await w.get(`/my/resumes/${b.id}/delete`);
    expect(confirm.status).toBe(200);
    const ch = await confirm.text();
    expect(ch).toContain('<b>B</b>');
    expect(ch).toContain('이미 낸 지원서는');
    expect(ch).toContain(`action="/my/resumes/${b.id}/delete"`);

    const del = await w.post(`/my/resumes/${b.id}/delete`);
    expect(del.headers.get('location')).toBe('/my/resumes?ok=deleted');
    expect(w.rows().map((r) => [r.title, r.is_default])).toEqual([['A', 1]]);
    expect([...w.store.keys()]).toEqual([a.file_r2_key]);
    expect((await w.post(`/my/resumes/${b.id}/delete`)).status).toBe(404);
    expect((await w.post('/my/resumes/nope/default')).status).toBe(404);
  });

  it('다른 구직자는 404, 기업 담당자·관리자는 403, 비로그인은 로그인 화면으로 — 모두 no-store', async () => {
    const w = world();
    const r = await create(w, {}, { bytes: pdf(), name: 'a.pdf' });
    const paths = [`/my/resumes/${r.id}/edit`, `/my/resumes/${r.id}/file`, `/my/resumes/${r.id}/delete`];
    for (const p of paths) {
      const res = await w.get(p, 's2');
      expect(res.status, p).toBe(404);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    for (const p of ['edit', 'copy', 'default', 'delete']) {
      const res = await w.post(`/my/resumes/${r.id}/${p}`, p === 'edit' ? editForm(w, r.id, { title: 'hack' }) : {}, 's2');
      expect(res.status, p).toBe(404);
    }
    expect((await (await w.get('/my/resumes', 's2')).text())).not.toContain(r.id);
    for (const who of ['co', 'adm'] as const) {
      for (const p of ['/my/resumes', '/my/resumes/new', ...paths]) {
        const res = await w.get(p, who);
        expect(res.status, `${who} ${p}`).toBe(403);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
      }
      expect((await w.post(`/my/resumes/${r.id}/delete`, {}, who)).status).toBe(403);
      expect((await w.post('/my/resumes/new', form(), who)).status).toBe(403);
    }
    const anon = await w.get('/my/resumes', null);
    expect([anon.status, anon.headers.get('location'), anon.headers.get('cache-control')]).toEqual([302, '/login', 'private, no-store']);
    // 아무것도 바뀌지 않았고, 열람 기록도 없다
    expect(w.rows()).toHaveLength(1);
    expect(w.rows()[0]!.title).toBe('영업직용');
    expect(w.store.size).toBe(1);
    expect(w.raw.prepare('SELECT COUNT(*) AS n FROM access_log').get()!.n).toBe(0);
  });

  it('열 수 없는 이력서(손상·다른 키): 목록에 표시, 편집·내려받기·복사는 404, 삭제는 된다', async () => {
    const w = world();
    const r = await create(w, { title: '깨진것' }, { bytes: pdf(), name: 'a.pdf' });
    w.raw.prepare("UPDATE resumes SET body = 'v1.AAAA.BBBB' WHERE id = ?").run(r.id);
    const list = await w.get('/my/resumes');
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('열 수 없는 이력서');
    expect(html).toContain('깨진것');
    expect(html).toContain(`/my/resumes/${r.id}/delete`);
    expect(html).not.toContain(`/my/resumes/${r.id}/edit`);
    expect(html).not.toContain(`/my/resumes/${r.id}/copy`);
    expect((await w.get(`/my/resumes/${r.id}/edit`)).status).toBe(404);
    expect((await w.get(`/my/resumes/${r.id}/file`)).status).toBe(404);
    expect((await w.post(`/my/resumes/${r.id}/copy`)).status).toBe(404);
    expect((await w.post(`/my/resumes/${r.id}/edit`, editForm(w, r.id))).status).toBe(404);
    expect((await w.post(`/my/resumes/${r.id}/delete`)).headers.get('location')).toBe('/my/resumes?ok=deleted');
    expect(w.rows()).toHaveLength(0);
    expect(w.store.size).toBe(0);
  });

  it('머리글과 /my 에 구직자용 이력서 링크 (기업 담당자에게는 없음)', async () => {
    const w = world();
    const my = await (await w.get('/my')).text();
    expect(my).toContain('href="/my/resumes"');
    const coJobs = await (await w.get('/jobs', 'co')).text();
    expect(coJobs).not.toContain('href="/my/resumes"');
  });
});
