// 기업·관리자의 지원서 열람 (T-09 핵심): 여는 길은 openApplication 하나 — 권한 → 사유 → 복호화 → 기록 → 상태.
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/lib/authz';
import { cleanReason, downloadApplicationFile, openApplication, refOf, ADMIN_REASON_MAX } from '../src/lib/applicants';
import { putResumeFile } from '../src/lib/resume-files';
import { b64url, importEncKey } from '../src/lib/crypto';
import { sealResume, type ResumeBody } from '../src/lib/resume';
import { countApplicationsByJob, getApplicationWithJob, listAccessLog, listJobApplications, listViewsOfApplication } from '../src/db/applicants';
import type { Env } from '../src/env';
import { hasSqlite, migratedDb } from './sqlite-d1';

const KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const mk = (p: Partial<Actor>): Actor => ({ id: 'm1', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });
const body: ResumeBody = {
  v: 1, name: '홍길동', chinese_level: 'business', years: 5, headline: '한 줄', contact_email: 'hong@example.test',
  phone: null, desired_role: null, experience_text: '경력', file: null,
};

describe('관리자 사유', () => {
  it('비어 있거나 너무 길면 없는 것으로 본다', () => {
    expect(cleanReason('  신고 처리\n확인 ')).toBe('신고 처리 확인');
    expect(cleanReason('   ')).toBeNull();
    expect(cleanReason(undefined)).toBeNull();
    expect(cleanReason('x'.repeat(ADMIN_REASON_MAX))).toHaveLength(ADMIN_REASON_MAX);
    expect(cleanReason('x'.repeat(ADMIN_REASON_MAX + 1))).toBeNull();
  });
});

describe.skipIf(!hasSqlite)('지원서 열기', () => {
  const setup = async () => {
    const { raw, d1 } = migratedDb();
    const sealed = await sealResume(await importEncKey(KEY), body);
    raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
      ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0), ('s3','s3@example.test','seeker','active',0), ('m1','m1@example.test','company','active',0), ('m2','m2@example.test','company','active',0),
      ('x1','x1@example.test','company','active',0), ('adm','adm@example.test','admin','active',0)`);
    raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0), ('c2','다른기업','kr_entity','verified',0)");
    raw.exec("INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, created_at, updated_at) VALUES ('j1','c1','m1','office','영업','본문','approved','published',0,0), ('j2','c2','x1','office','다른공고','본문','approved','published',0,0)");
    const ins = raw.prepare("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, file_r2_key, cross_border_consent_at, status, status_changed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run('a1', 'j1', 's1', sealed, 'rfiles/k', null, 'submitted', 10, 10);
    const env = { ENC_KEY: KEY, DB: d1 } as unknown as Env;
    const load = async (id = 'a1') => (await getApplicationWithJob(d1, id))!;
    const count = (t: string) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n);
    return { raw, d1, env, load, count, sealed, ins };
  };
  const local = mk({ id: 'm1', companyIds: ['c1'] });
  const hq = mk({ id: 'm2', companyIds: ['c1'], hqCompanyIds: ['c1'] });

  it('그 기업의 담당자가 열면: 내용이 나오고, 기록이 남고, 상태가 "열람함" 으로 바뀐다', async () => {
    const { env, load, count, raw } = await setup();
    const r = await openApplication(env, local, await load(), null);
    expect(r).toMatchObject({ ok: true, status: 'viewed', needsReason: false });
    if (r.ok) expect(r.body.name).toBe('홍길동');
    expect({ ...raw.prepare('SELECT actor_id, actor_role, target_type, target_id, reason FROM access_log').get()! })
      .toEqual({ actor_id: 'm1', actor_role: 'company', target_type: 'application', target_id: 'a1', reason: null });
    expect({ ...raw.prepare('SELECT application_id, event, actor_id FROM application_events').get()! }).toEqual({ application_id: 'a1', event: 'viewed', actor_id: 'm1' });
    expect((await load()).status).toBe('viewed');
    // 다시 열면 기록은 또 남지만, 이벤트·상태는 그대로다
    expect(await openApplication(env, local, await load(), null)).toMatchObject({ ok: true, status: 'viewed' });
    expect([count('access_log'), count('application_events')]).toEqual([2, 1]);
  });
  it('다른 기업의 담당자·구직자는 열 수 없고, 기록도 상태 변화도 없다', async () => {
    const { env, load, count } = await setup();
    expect(await openApplication(env, mk({ id: 'x1', companyIds: ['c2'] }), await load(), null)).toEqual({ ok: false, why: 'forbidden' });
    expect(await openApplication(env, mk({ id: 's1', role: 'seeker' }), await load(), null)).toEqual({ ok: false, why: 'forbidden' });
    expect(await openApplication(env, mk({ id: 'h1', role: 'headhunter', agencyIds: ['a9'] }), await load(), null)).toEqual({ ok: false, why: 'forbidden' });
    expect([count('access_log'), count('application_events'), (await load()).status]).toEqual([0, 0, 'submitted']);
  });
  it('중국 본사 담당자는 국외 이전 동의가 있을 때만 연다', async () => {
    const { env, load, count, raw } = await setup();
    expect(await openApplication(env, hq, await load(), null)).toEqual({ ok: false, why: 'no_cross_border_consent' });
    expect(count('access_log')).toBe(0);
    raw.exec("UPDATE applications SET cross_border_consent_at = 5 WHERE id = 'a1'");
    expect(await openApplication(env, hq, await load(), null)).toMatchObject({ ok: true, status: 'viewed' });
  });
  it('취소된 지원은 기업도 관리자도 열 수 없다', async () => {
    const { env, load, count, raw } = await setup();
    raw.exec("UPDATE applications SET status = 'withdrawn', resume_snapshot = '', file_r2_key = NULL WHERE id = 'a1'");
    expect(await openApplication(env, local, await load(), null)).toEqual({ ok: false, why: 'withdrawn' });
    expect(await openApplication(env, mk({ id: 'adm', role: 'admin' }), await load(), '사유')).toEqual({ ok: false, why: 'withdrawn' });
    expect(count('access_log')).toBe(0);
  });
  it('관리자는 사유가 있어야 열리고, 사유가 기록되며, 상태는 바뀌지 않는다', async () => {
    const { env, load, count, raw } = await setup();
    const admin = mk({ id: 'adm', role: 'admin' });
    expect(await openApplication(env, admin, await load(), null)).toEqual({ ok: false, why: 'reason_required' });
    expect(await openApplication(env, admin, await load(), '  ')).toEqual({ ok: false, why: 'reason_required' });
    expect(count('access_log')).toBe(0);
    expect(await openApplication(env, admin, await load(), '신고 #12 확인')).toMatchObject({ ok: true, status: 'submitted', needsReason: true });
    expect({ ...raw.prepare('SELECT actor_id, actor_role, reason FROM access_log').get()! }).toEqual({ actor_id: 'adm', actor_role: 'admin', reason: '신고 #12 확인' });
    expect([count('application_events'), (await load()).status]).toEqual([0, 'submitted']);
  });
  it('열 수 없는(손상된) 지원서는 내용도 기록도 없다', async () => {
    const { env, load, count, raw } = await setup();
    raw.exec("UPDATE applications SET resume_snapshot = 'v1.AAAA.BBBB' WHERE id = 'a1'");
    expect(await openApplication(env, local, await load(), null)).toEqual({ ok: false, why: 'unreadable' });
    expect([count('access_log'), count('application_events'), (await load()).status]).toEqual([0, 0, 'submitted']);
  });
  it('기록을 남기지 못하면 내용을 돌려주지 않는다', async () => {
    const { env, load, d1 } = await setup();
    const broken = { ...env, DB: { ...d1, prepare: (sql: string) => { if (sql.includes('access_log')) throw new Error('db down'); return d1.prepare(sql); }, batch: d1.batch } } as unknown as Env;
    await expect(openApplication(broken, local, await load(), null)).rejects.toThrow();
  });
  it('이미 끝난 지원(불합격)은 열어도 상태가 바뀌지 않는다', async () => {
    const { env, load, count, raw } = await setup();
    raw.exec("UPDATE applications SET status = 'rejected' WHERE id = 'a1'");
    expect(await openApplication(env, local, await load(), null)).toMatchObject({ ok: true, status: 'rejected' });
    expect([count('access_log'), count('application_events')]).toEqual([1, 0]);
  });
  it('권한 판단에 쓰는 값은 공고의 소속에서 온다', async () => {
    const { load } = await setup();
    expect(refOf(await load())).toEqual({ seeker_id: 's1', job: { company_id: 'c1', agency_id: null, created_by: 'm1' }, cross_border_consent_at: null, status: 'submitted' });
  });

  it('첨부파일 내려받기: 권한·사유·기록은 열람과 같고, 상태는 바꾸지 않는다', async () => {
    const { env, load, count, raw } = await setup();
    const store = new Map<string, Uint8Array>();
    const fenv = { ...env, FILES: {
      put: async (k: string, v: Uint8Array) => { store.set(k, v); },
      get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
      delete: async (k: string) => { store.delete(k); },
    } } as unknown as Env;
    const pdf = new TextEncoder().encode('%PDF-1.4 fake');
    const key = await putResumeFile(fenv, pdf);
    const withFile = await sealResume(await importEncKey(KEY), { ...body, file: { name: '이력서.pdf', ext: 'pdf', mime: 'application/pdf', size: pdf.length } });
    raw.prepare('UPDATE applications SET resume_snapshot = ?, file_r2_key = ? WHERE id = ?').run(withFile, key, 'a1');
    const res = await downloadApplicationFile(fenv, local, await load(), null);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(pdf);
    expect([count('access_log'), count('application_events'), (await load()).status]).toEqual([1, 0, 'submitted']);
    expect(await downloadApplicationFile(fenv, mk({ id: 'x1', companyIds: ['c2'] }), await load(), null)).toBeNull();
    expect(await downloadApplicationFile(fenv, hq, await load(), null)).toBeNull();
    expect(await downloadApplicationFile(fenv, mk({ id: 's1', role: 'seeker' }), await load(), null)).toBeNull();
    expect(await downloadApplicationFile(fenv, mk({ id: 'adm', role: 'admin' }), await load(), ' ')).toBeNull();
    expect(count('access_log')).toBe(1);
    expect(await downloadApplicationFile(fenv, mk({ id: 'adm', role: 'admin' }), await load(), '확인')).not.toBeNull();
    expect(raw.prepare("SELECT reason FROM access_log WHERE actor_role = 'admin'").get()!.reason).toBe('확인');
    // 첨부가 없는 지원서
    raw.exec("UPDATE applications SET file_r2_key = NULL WHERE id = 'a1'");
    expect(await downloadApplicationFile(fenv, local, await load(), null)).toBeNull();
  });
  it('지원자 목록에는 지원서 내용이 없다 (암호문도 돌려주지 않는다)', async () => {
    const { d1, ins, sealed } = await setup();
    ins.run('a2', 'j1', 's2', sealed, null, 7, 'withdrawn', 30, 20);
    const rows = await listJobApplications(d1, 'j1');
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'cross_border_consent_at', 'has_file', 'id', 'status', 'status_changed_at']);
    expect(rows.map((r) => r.has_file)).toEqual([1, 0]);
    expect(JSON.stringify(rows)).not.toContain('v1.');
    expect(await listJobApplications(d1, 'j2')).toEqual([]);
  });
  it('공고별 지원 수: 취소는 빼고, 아직 열지 않은 수를 따로 센다 (다른 기업 것은 없다)', async () => {
    const { d1, ins, sealed } = await setup();
    ins.run('a2', 'j1', 's2', sealed, null, null, 'viewed', 30, 20);
    ins.run('a3', 'j1', 's3', sealed, null, null, 'withdrawn', 30, 20);
    ins.run('b1', 'j2', 's1', sealed, null, null, 'submitted', 30, 20);
    expect(await countApplicationsByJob(d1, 'c1')).toEqual({ j1: { total: 2, unread: 1 } });
    expect(await countApplicationsByJob(d1, 'c2')).toEqual({ j2: { total: 1, unread: 1 } });
    expect(await countApplicationsByJob(d1, 'none')).toEqual({});
  });
  it('열람 기록 조회: 관리자용 목록과 구직자용(역할·시각만, 본인 제외)', async () => {
    const { env, load, d1 } = await setup();
    await openApplication(env, local, await load(), null);
    await openApplication(env, mk({ id: 'adm', role: 'admin' }), await load(), '확인');
    const all = await listAccessLog(d1, { limit: 10 });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.actor_email).sort()).toEqual(['adm@example.test', 'm1@example.test']);
    expect(await listAccessLog(d1, { limit: 10, targetType: 'resume' })).toEqual([]);
    expect(await listAccessLog(d1, { limit: 1 })).toHaveLength(1);
    const mine = await listViewsOfApplication(d1, 'a1', 's1');
    expect(mine.map((r) => r.actor_role).sort()).toEqual(['admin', 'company']);
    expect(Object.keys(mine[0]!).sort()).toEqual(['actor_role', 'at']);
  });
});
