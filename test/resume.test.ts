// 이력서: 권한, 항목 검사, 암호화 저장, 첨부파일 종류 판별·암호화, DB 문장(한도·대표 지정·삭제).
import { describe, expect, it } from 'vitest';
import { canEditResume, canViewResume, type Actor } from '../src/lib/authz';
import { b64url, importEncKey } from '../src/lib/crypto';
import {
  copyTitle, inputFromResume, openResume, readResumeForm, resumeReadyToApply, sealResume, translatableFields, validateResume,
  EMPTY_RESUME_INPUT, RESUME_LIMITS, RESUME_MAX_PER_USER, type ResumeBody, type ResumeInput,
} from '../src/lib/resume';
import {
  checkResumeUpload, decryptFile, encryptFile, newResumeFileKey, rfc5987, safeFileName, serveResumeFile, sniffResumeFile, RESUME_FILE_MAX_BYTES,
} from '../src/lib/resume-files';
import { deleteResume, getResume, insertResume, listResumes, setDefaultResume, updateResume } from '../src/db/resumes';
import type { Env } from '../src/env';
import { hasSqlite, migratedDb } from './sqlite-d1';

const mk = (p: Partial<Actor>): Actor => ({ id: 'u1', role: 'seeker', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });
const keyB64 = (fill: number) => b64url(new Uint8Array(32).fill(fill)).replace(/-/g, '+').replace(/_/g, '/');
const key = (fill = 7) => importEncKey(keyB64(fill));
const te = new TextEncoder();

const good: ResumeInput = {
  ...EMPTY_RESUME_INPUT, title: '영업직용', name: '홍길동', chinese_level: 'business', years: '5',
  headline: '중국 본사와 일해 본 B2B 영업 5년', contact_email: 'hong@example.test',
};
const body: ResumeBody = {
  v: 1, name: '홍길동', chinese_level: 'business', years: 5, headline: '한 줄', contact_email: 'hong@example.test',
  phone: '010-0000-0000', desired_role: '영업', experience_text: '경력 요약', file: { name: '이력서.pdf', ext: 'pdf', mime: 'application/pdf', size: 10 },
};

describe('이력서 권한', () => {
  it('구직자는 본인 것만 보고 고친다', () => {
    expect(canViewResume(mk({}), { user_id: 'u1' })).toEqual({ allow: true, needsReason: false });
    expect(canViewResume(mk({}), { user_id: 'u2' }).allow).toBe(false);
    expect(canEditResume(mk({}), { user_id: 'u1' })).toBe(true);
    expect(canEditResume(mk({}), { user_id: 'u2' })).toBe(false);
  });
  it('기업 담당자·헤드헌터는 이력서 원본을 볼 수 없다 (소속 기업이 어디든)', () => {
    expect(canViewResume(mk({ role: 'company', companyIds: ['c1'], hqCompanyIds: ['c1'] }), { user_id: 'u1' }).allow).toBe(false);
    expect(canViewResume(mk({ role: 'headhunter', agencyIds: ['a1'] }), { user_id: 'u1' }).allow).toBe(false);
    // id 가 같아도 역할이 구직자가 아니면 안 된다
    expect(canViewResume(mk({ role: 'company' }), { user_id: 'u1' }).allow).toBe(false);
  });
  it('관리자는 사유가 있어야 열리고, 고칠 수는 없다', () => {
    expect(canViewResume(mk({ role: 'admin' }), { user_id: 'u1' })).toEqual({ allow: true, needsReason: true });
    expect(canEditResume(mk({ role: 'admin' }), { user_id: 'u1' })).toBe(false);
    expect(canEditResume(mk({ role: 'company' }), { user_id: 'u1' })).toBe(false);
  });
});

describe('이력서 항목 검사', () => {
  it('필수 다섯 개와 이름표만 있으면 통과한다', () => {
    const r = validateResume(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toEqual({
      name: '홍길동', chinese_level: 'business', years: 5, headline: good.headline, contact_email: 'hong@example.test',
      phone: null, desired_role: null, experience_text: null,
    });
  });
  it('필수 항목이 비면 항목별 오류', () => {
    const r = validateResume(EMPTY_RESUME_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => `${e.field}:${e.code}`).sort()).toEqual(
      ['chinese_level:required', 'contact_email:required', 'headline:required', 'name:required', 'title:required', 'years:required'],
    );
  });
  it('형식·길이', () => {
    const bad = (p: Partial<ResumeInput>) => { const r = validateResume({ ...good, ...p }); return r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`); };
    expect(bad({ contact_email: 'not-an-email' })).toEqual(['contact_email:invalid']);
    expect(bad({ chinese_level: 'fluent' })).toEqual(['chinese_level:invalid']);
    expect(bad({ years: '-1' })).toEqual(['years:invalid']);
    expect(bad({ years: '61' })).toEqual(['years:invalid']);
    expect(bad({ years: '3.5' })).toEqual(['years:invalid']);
    expect(bad({ years: '0' })).toEqual([]);
    expect(bad({ phone: 'call me' })).toEqual(['phone:invalid']);
    expect(bad({ phone: '123' })).toEqual(['phone:invalid']);
    expect(bad({ phone: '+86 138 0000 0000' })).toEqual([]);
    expect(bad({ headline: 'x'.repeat(RESUME_LIMITS.headline + 1) })).toEqual(['headline:too_long']);
    expect(bad({ experience_text: 'x'.repeat(RESUME_LIMITS.experience_text + 1) })).toEqual(['experience_text:too_long']);
  });
  it('폼 읽기: 한 줄 항목의 줄바꿈·제어 문자를 없애고, 이메일은 소문자로', () => {
    const i = readResumeForm({ title: ' 영업\n직용 ', name: '홍\u0000길동', contact_email: ' Hong@Example.TEST ', experience_text: 'a\r\nb\u0007c', years: ' 5 ', phone: 123 });
    expect(i.title).toBe('영업 직용');
    expect(i.name).toBe('홍 길동');
    expect(i.contact_email).toBe('hong@example.test');
    expect(i.experience_text).toBe('a\nbc');
    expect(i.years).toBe('5');
    expect(i.phone).toBe('');
  });
  it('저장된 내용을 폼 값으로 되돌린다', () => {
    expect(inputFromResume('t', body)).toEqual({
      title: 't', name: '홍길동', chinese_level: 'business', years: '5', headline: '한 줄', contact_email: 'hong@example.test',
      phone: '010-0000-0000', desired_role: '영업', experience_text: '경력 요약',
    });
  });
  it('지원 가능 여부: 첨부파일이나 경력 요약 중 하나', () => {
    expect(resumeReadyToApply(body)).toBe(true);
    expect(resumeReadyToApply({ ...body, file: null })).toBe(true);
    expect(resumeReadyToApply({ ...body, experience_text: null })).toBe(true);
    expect(resumeReadyToApply({ ...body, file: null, experience_text: '  ' })).toBe(false);
  });
  it('번역 엔진에 보낼 항목에는 이름·연락처·파일 정보가 없다', () => {
    const t = translatableFields(body);
    expect(Object.keys(t).sort()).toEqual(['chinese_level', 'desired_role', 'experience_text', 'headline', 'years']);
    const s = JSON.stringify(t);
    for (const secret of ['홍길동', 'hong@example.test', '010-0000-0000', '이력서.pdf']) expect(s).not.toContain(secret);
  });
  it('복사본 이름표는 길이 제한 안에 든다', () => {
    expect(copyTitle('영업직용', '(복사)')).toBe('영업직용 (복사)');
    expect(copyTitle('가'.repeat(40), '(복사)').length).toBe(RESUME_LIMITS.title);
  });
});

describe('이력서 암호화 저장', () => {
  it('암호문에는 평문이 없고, 같은 키로 그대로 되돌아온다', async () => {
    const k = await key();
    const sealed = await sealResume(k, body);
    expect(sealed.startsWith('v1.')).toBe(true);
    for (const secret of ['홍길동', 'hong', '010', '이력서', 'business']) expect(sealed).not.toContain(secret);
    expect(await openResume(k, sealed)).toEqual(body);
    // 같은 내용을 두 번 암호화하면 다른 암호문 (iv 가 매번 다르다)
    expect(await sealResume(k, body)).not.toBe(sealed);
  });
  it('다른 키·변조된 값·모양이 다른 값은 열리지 않는다', async () => {
    const sealed = await sealResume(await key(7), body);
    await expect(openResume(await key(8), sealed)).rejects.toThrow();
    const parts = sealed.split('.');
    const ct = parts[2]!;
    const flipped = `${parts[0]}.${parts[1]}.${ct.slice(0, -2)}${ct.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(openResume(await key(7), flipped)).rejects.toThrow();
    await expect(openResume(await key(7), 'plain text')).rejects.toThrow();
    const { encryptText } = await import('../src/lib/crypto');
    await expect(openResume(await key(7), await encryptText(await key(7), JSON.stringify({ v: 2, name: 'x' })))).rejects.toThrow();
    await expect(openResume(await key(7), await encryptText(await key(7), JSON.stringify({ ...body, file: { name: 'x', ext: 'exe', mime: 'x', size: 1 } })))).rejects.toThrow();
  });
});

// 최소한의 가짜 파일
const pdf = () => te.encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
const zipWith = (name: string) => {
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const tail = te.encode(`PK\u0001\u0002....${name}....PK\u0005\u0006`);
  const out = new Uint8Array(head.length + 200 + tail.length);
  out.set(head, 0);
  out.set(tail, head.length + 200);
  return out;
};

describe('첨부파일 종류 판별', () => {
  it('PDF 와 DOCX 만 받는다 (내용으로 판별)', () => {
    expect(sniffResumeFile(pdf())?.ext).toBe('pdf');
    expect(sniffResumeFile(zipWith('word/document.xml'))?.ext).toBe('docx');
    expect(sniffResumeFile(zipWith('xl/workbook.xml'))).toBeNull();        // xlsx
    expect(sniffResumeFile(zipWith('ppt/presentation.xml'))).toBeNull();   // pptx
    expect(sniffResumeFile(zipWith('evil.exe'))).toBeNull();               // 일반 zip
    expect(sniffResumeFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull(); // hwp·doc
    expect(sniffResumeFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // jpg
    expect(sniffResumeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull(); // png
    expect(sniffResumeFile(te.encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffResumeFile(te.encode('MZ\u0090\u0000'))).toBeNull();
    expect(sniffResumeFile(new Uint8Array(0))).toBeNull();
  });
  it('확장자를 속여도 내용으로 판단한다', async () => {
    const fake = await checkResumeUpload(new File([te.encode('MZ not a pdf')], 'resume.pdf', { type: 'application/pdf' }));
    expect(fake).toEqual({ ok: false, why: 'bad_type' });
    const real = await checkResumeUpload(new File([pdf()], '../../홍길동 이력서.exe', { type: 'application/x-msdownload' }));
    expect(real.ok).toBe(true);
    if (real.ok) expect(real.meta).toEqual({ name: '홍길동 이력서.pdf', ext: 'pdf', mime: 'application/pdf', size: pdf().length });
  });
  it('빈 파일·너무 큰 파일·파일이 아닌 값', async () => {
    expect(await checkResumeUpload(new File([], 'a.pdf'))).toEqual({ ok: false, why: 'empty' });
    expect(await checkResumeUpload('a.pdf')).toEqual({ ok: false, why: 'empty' });
    expect(await checkResumeUpload(undefined)).toEqual({ ok: false, why: 'empty' });
    const big = new Uint8Array(RESUME_FILE_MAX_BYTES + 1);
    big.set(te.encode('%PDF-1.4'), 0);
    expect(await checkResumeUpload(new File([big], 'big.pdf'))).toEqual({ ok: false, why: 'too_large' });
  });
  it('파일명 정리', () => {
    expect(safeFileName('C:\\Users\\me\\이력서 최종.docx', 'docx')).toBe('이력서 최종.docx');
    expect(safeFileName('a"b;c%0d%0a\r\nx.pdf', 'pdf')).toBe('a b c 0d 0a x.pdf');
    expect(safeFileName('.pdf', 'pdf')).toBe('resume.pdf');
    expect(safeFileName(`${'가'.repeat(200)}.pdf`, 'pdf').length).toBe(84);
  });
});

describe('첨부파일 암호화', () => {
  it('저장 바이트에 원문이 없고, 같은 키·같은 R2 키로만 풀린다', async () => {
    const k = await key();
    const plain = pdf();
    const r2 = newResumeFileKey();
    expect(r2).toMatch(/^rfiles\/[0-9a-f-]{36}$/);
    const sealed = await encryptFile(k, plain, r2);
    expect(sealed.length).toBe(3 + 12 + plain.length + 16);
    expect(new TextDecoder('latin1').decode(sealed)).not.toContain('%PDF');
    expect(await decryptFile(k, sealed, r2)).toEqual(plain);
    await expect(decryptFile(await key(8), sealed, r2)).rejects.toThrow();            // 다른 키
    await expect(decryptFile(k, sealed, newResumeFileKey())).rejects.toThrow();       // 다른 위치로 옮겨 놓음
    const t = sealed.slice(); t[t.length - 1]! ^= 1;
    await expect(decryptFile(k, t, r2)).rejects.toThrow();                            // 한 비트 변조
    await expect(decryptFile(k, plain, r2)).rejects.toThrow();                        // 암호화되지 않은 바이트
    await expect(decryptFile(k, sealed.subarray(0, 20), r2)).rejects.toThrow();
  });
});

// ── 내려받기: 권한 → 기록 → 복호화 → 전송
function fakeEnv() {
  const store = new Map<string, Uint8Array>();
  const logs: unknown[][] = [];
  const env = {
    ENC_KEY: keyB64(7),
    FILES: {
      put: async (k: string, v: Uint8Array) => { store.set(k, v); },
      get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
      delete: async (k: string) => { store.delete(k); },
    },
    DB: { prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ run: async () => { logs.push([sql, ...b]); return { meta: { changes: 1 } }; } }) }) },
  } as unknown as Env;
  return { env, store, logs };
}

describe('첨부파일 내려받기', () => {
  const meta = { name: '홍길동 이력서.pdf', ext: 'pdf' as const, mime: 'application/pdf', size: 0 };
  it('본인은 받고, 기록이 남고, 항상 저장(attachment)으로 내려간다', async () => {
    const { env, store, logs } = fakeEnv();
    const { putResumeFile } = await import('../src/lib/resume-files');
    const r2 = await putResumeFile(env, pdf());
    expect(new TextDecoder('latin1').decode(store.get(r2)!)).not.toContain('%PDF');
    const res = await serveResumeFile(env, mk({}), { id: 'r1', user_id: 'u1', file_r2_key: r2 }, meta, null);
    expect(res).not.toBeNull();
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(pdf());
    expect(res!.headers.get('content-disposition')).toBe(`attachment; filename="resume.pdf"; filename*=UTF-8''${rfc5987(meta.name)}`);
    expect(rfc5987("이력서 (최종)'s*.pdf")).toBe('%EC%9D%B4%EB%A0%A5%EC%84%9C%20%28%EC%B5%9C%EC%A2%85%29%27s%2A.pdf');
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.slice(2)).toEqual(expect.arrayContaining(['u1', 'seeker', 'resume', 'r1']));
  });
  it('다른 구직자·기업 담당자는 받지 못하고 기록도 없다', async () => {
    const { env, logs } = fakeEnv();
    const { putResumeFile } = await import('../src/lib/resume-files');
    const r2 = await putResumeFile(env, pdf());
    const resume = { id: 'r1', user_id: 'u1', file_r2_key: r2 };
    expect(await serveResumeFile(env, mk({ id: 'u2' }), resume, meta, null)).toBeNull();
    expect(await serveResumeFile(env, mk({ id: 'c', role: 'company', companyIds: ['c1'] }), resume, meta, null)).toBeNull();
    expect(await serveResumeFile(env, mk({ id: 'h', role: 'headhunter', agencyIds: ['a1'] }), resume, meta, null)).toBeNull();
    expect(logs).toHaveLength(0);
  });
  it('관리자는 사유가 없으면 열리지 않고, 있으면 사유와 함께 기록된다', async () => {
    const { env, logs } = fakeEnv();
    const { putResumeFile } = await import('../src/lib/resume-files');
    const resume = { id: 'r1', user_id: 'u1', file_r2_key: await putResumeFile(env, pdf()) };
    const admin = mk({ id: 'adm', role: 'admin' });
    expect(await serveResumeFile(env, admin, resume, meta, null)).toBeNull();
    expect(await serveResumeFile(env, admin, resume, meta, '   ')).toBeNull();
    expect(logs).toHaveLength(0);
    expect(await serveResumeFile(env, admin, resume, meta, '신고 처리 확인')).not.toBeNull();
    expect(logs[0]).toEqual(expect.arrayContaining(['adm', 'admin', 'resume', 'r1', '신고 처리 확인']));
  });
  it('파일이 없거나 변조됐으면 내려주지 않고 기록도 없다', async () => {
    const { env, store, logs } = fakeEnv();
    const { putResumeFile } = await import('../src/lib/resume-files');
    const r2 = await putResumeFile(env, pdf());
    expect(await serveResumeFile(env, mk({}), { id: 'r1', user_id: 'u1', file_r2_key: null }, meta, null)).toBeNull();
    expect(await serveResumeFile(env, mk({}), { id: 'r1', user_id: 'u1', file_r2_key: 'rfiles/none' }, meta, null)).toBeNull();
    const v = store.get(r2)!.slice(); v[20]! ^= 1; store.set(r2, v);
    expect(await serveResumeFile(env, mk({}), { id: 'r1', user_id: 'u1', file_r2_key: r2 }, meta, null)).toBeNull();
    expect(logs).toHaveLength(0);
  });
});

describe.skipIf(!hasSqlite)('이력서 DB 문장', () => {
  const setup = () => {
    const { raw, d1 } = migratedDb();
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('u1','u1@example.test','seeker',0), ('u2','u2@example.test','seeker',0)");
    return { raw, d1 };
  };
  const add = (d1: D1Database, id: string, userId = 'u1', ts = 100) =>
    insertResume(d1, { id, userId, title: id, body: 'v1.x.y', fileKey: null, ts }, RESUME_MAX_PER_USER);
  const defaults = async (d1: D1Database, userId = 'u1') => (await listResumes(d1, userId)).filter((r) => r.is_default === 1).map((r) => r.id);

  it('첫 이력서가 대표가 되고, 다섯 개까지만 저장된다', async () => {
    const { d1 } = setup();
    for (let i = 1; i <= 5; i++) expect(await add(d1, `r${i}`, 'u1', 100 + i)).toBe(true);
    expect(await add(d1, 'r6')).toBe(false);
    expect(await defaults(d1)).toEqual(['r1']);
    expect((await listResumes(d1, 'u1')).map((r) => r.id)).toEqual(['r1', 'r5', 'r4', 'r3', 'r2']); // 대표가 맨 위, 그다음 최근 순
    // 다른 회원의 한도·대표와는 무관하다
    expect(await add(d1, 'x1', 'u2')).toBe(true);
    expect(await defaults(d1, 'u2')).toEqual(['x1']);
  });
  it('다른 회원의 이력서는 읽지도, 고치지도, 대표로 지정하지도, 지우지도 못한다', async () => {
    const { d1 } = setup();
    await add(d1, 'r1'); await add(d1, 'x1', 'u2');
    expect(await getResume(d1, 'r1', 'u2')).toBeNull();
    expect(await updateResume(d1, { id: 'r1', userId: 'u2', title: 'hack', body: 'b', fileKey: null, ts: 200, expectedUpdatedAt: 100 })).toBe(false);
    expect(await setDefaultResume(d1, 'r1', 'u2')).toBe(false);
    expect(await defaults(d1, 'u2')).toEqual(['x1']); // 실패한 지정이 기존 대표를 내리지 않는다
    expect(await deleteResume(d1, 'r1', 'u2')).toBe(false);
    expect((await getResume(d1, 'r1', 'u1'))?.title).toBe('r1');
  });
  it('수정은 화면을 연 뒤 바뀌지 않았을 때만', async () => {
    const { d1 } = setup();
    await add(d1, 'r1');
    expect(await updateResume(d1, { id: 'r1', userId: 'u1', title: 't2', body: 'b2', fileKey: 'rfiles/k', ts: 200, expectedUpdatedAt: 100 })).toBe(true);
    expect(await updateResume(d1, { id: 'r1', userId: 'u1', title: 't3', body: 'b3', fileKey: null, ts: 300, expectedUpdatedAt: 100 })).toBe(false);
    expect(await getResume(d1, 'r1', 'u1')).toMatchObject({ title: 't2', body: 'b2', file_r2_key: 'rfiles/k', updated_at: 200, is_default: 1 });
  });
  it('대표 지정: 하나만 대표로 남는다', async () => {
    const { d1 } = setup();
    await add(d1, 'r1'); await add(d1, 'r2'); await add(d1, 'r3');
    expect(await setDefaultResume(d1, 'r2', 'u1')).toBe(true);
    expect(await defaults(d1)).toEqual(['r2']);
    expect(await setDefaultResume(d1, 'r2', 'u1')).toBe(true); // 이미 대표인 것을 다시 지정해도 된다
    expect(await defaults(d1)).toEqual(['r2']);
    expect(await setDefaultResume(d1, 'nope', 'u1')).toBe(false);
    expect(await defaults(d1)).toEqual(['r2']);
  });
  it('대표를 지우면 가장 최근에 고친 것이 대표가 되고, 대표가 아닌 것을 지우면 그대로다', async () => {
    const { d1 } = setup();
    await add(d1, 'r1', 'u1', 100); await add(d1, 'r2', 'u1', 300); await add(d1, 'r3', 'u1', 200);
    expect(await deleteResume(d1, 'r3', 'u1')).toBe(true);
    expect(await defaults(d1)).toEqual(['r1']);
    expect(await deleteResume(d1, 'r1', 'u1')).toBe(true);
    expect(await defaults(d1)).toEqual(['r2']);
    expect(await deleteResume(d1, 'r2', 'u1')).toBe(true);
    expect(await listResumes(d1, 'u1')).toEqual([]);
    expect(await deleteResume(d1, 'r2', 'u1')).toBe(false);
    // 다 지운 뒤 새로 만들면 다시 대표가 된다
    await add(d1, 'r9');
    expect(await defaults(d1)).toEqual(['r9']);
  });
});
