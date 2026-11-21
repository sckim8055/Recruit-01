// 지원: 열람 권한(취소 포함), 국외 이전 동의 필요 여부, 지원 가능 여부, 복사본, 취소, DB 문장, 첨부파일 내려받기.
import { describe, expect, it } from 'vitest';
import { canViewApplication, type Actor, type ApplicationRef } from '../src/lib/authz';
import { applyBlocks, buildSnapshot, canWithdraw, consentAt, consentNeed, newApplicantMail, WITHDRAWABLE, CROSS_BORDER_VERSION } from '../src/lib/application';
import { serveApplicationFile } from '../src/lib/application-files';
import { b64url } from '../src/lib/crypto';
import { t } from '../src/lib/i18n';
import { putResumeFile } from '../src/lib/resume-files';
import type { ResumeBody } from '../src/lib/resume';
import { nextStatus } from '../src/lib/rules';
import {
  companyMemberEmails, getOwnApplication, hasApplied, insertApplication, listOwnApplications, memberCounts, withdrawApplication,
} from '../src/db/applications';
import type { Env, Flags } from '../src/env';
import { hasSqlite, migratedDb } from './sqlite-d1';

const mk = (p: Partial<Actor>): Actor => ({ id: 'x', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });
const job = { company_id: 'c1', agency_id: null, created_by: 'u9' };
const ref = (p: Partial<ApplicationRef> = {}): ApplicationRef => ({ seeker_id: 's1', job, cross_border_consent_at: null, status: 'submitted', ...p });
const FLAGS: Flags = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };

describe('지원서 열람 권한: 취소된 지원', () => {
  it('취소된 지원은 본인만 본다 (기업·헤드헌터·관리자 모두 불가)', () => {
    const w = ref({ status: 'withdrawn', cross_border_consent_at: 1 });
    expect(canViewApplication(mk({ role: 'seeker', id: 's1' }), w).allow).toBe(true);
    expect(canViewApplication(mk({ companyIds: ['c1'] }), w)).toEqual({ allow: false, why: 'withdrawn' });
    expect(canViewApplication(mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] }), w)).toEqual({ allow: false, why: 'withdrawn' });
    expect(canViewApplication(mk({ role: 'admin' }), w)).toEqual({ allow: false, why: 'withdrawn' });
    expect(canViewApplication(mk({ role: 'headhunter', agencyIds: ['a1'] }), ref({ status: 'withdrawn', job: { ...job, agency_id: 'a1' } })).allow).toBe(false);
  });
  it('진행 중인 지원은 예전 규칙 그대로', () => {
    expect(canViewApplication(mk({ companyIds: ['c1'] }), ref()).allow).toBe(true);
    expect(canViewApplication(mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] }), ref())).toEqual({ allow: false, why: 'no_cross_border_consent' });
    expect(canViewApplication(mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] }), ref({ cross_border_consent_at: 5 })).allow).toBe(true);
    expect(canViewApplication(mk({ companyIds: ['c2'] }), ref()).allow).toBe(false);
  });
});

describe('국외 이전 동의', () => {
  it('본사 담당자가 없으면 필요 없음, 본사만 있으면 필수, 섞여 있으면 선택', () => {
    expect(consentNeed({ hqMembers: 0, localMembers: 3 })).toBe('none');
    expect(consentNeed({ hqMembers: 0, localMembers: 0 })).toBe('none');
    expect(consentNeed({ hqMembers: 2, localMembers: 0 })).toBe('required');
    expect(consentNeed({ hqMembers: 1, localMembers: 1 })).toBe('optional');
  });
  it('필요 없는 동의는 체크해도 저장하지 않는다', () => {
    expect(consentAt('none', true, 100)).toBeNull();
    expect(consentAt('optional', false, 100)).toBeNull();
    expect(consentAt('optional', true, 100)).toBe(100);
    expect(consentAt('required', true, 100)).toBe(100);
  });
});

describe('지원 가능 여부', () => {
  const ok = { canApply: true, jobVisible: true, alreadyApplied: false, resumeReady: true, consentNeed: 'none' as const, consentGiven: false };
  it('모두 만족하면 빈 배열', () => expect(applyBlocks(ok)).toEqual([]));
  it('막는 사유', () => {
    expect(applyBlocks({ ...ok, canApply: false })).toEqual(['not_seeker']);
    expect(applyBlocks({ ...ok, jobVisible: false })).toEqual(['job_not_open']);
    expect(applyBlocks({ ...ok, alreadyApplied: true })).toEqual(['already_applied']);
    expect(applyBlocks({ ...ok, resumeReady: false })).toEqual(['resume_not_ready']);
    expect(applyBlocks({ ...ok, consentNeed: 'required' })).toEqual(['consent_required']);
    expect(applyBlocks({ ...ok, consentNeed: 'required', consentGiven: true })).toEqual([]);
    expect(applyBlocks({ ...ok, consentNeed: 'optional' })).toEqual([]);
    expect(applyBlocks({ canApply: false, jobVisible: false, alreadyApplied: true, resumeReady: false, consentNeed: 'required', consentGiven: false })).toHaveLength(5);
  });
});

const base: ResumeBody = {
  v: 1, name: '홍길동', chinese_level: 'business', years: 5, headline: '원본', contact_email: 'hong@example.test',
  phone: null, desired_role: null, experience_text: '원본 경력', file: { name: '이력서.pdf', ext: 'pdf', mime: 'application/pdf', size: 10 },
};

describe('지원서 복사본', () => {
  const edited = { name: '홍길동', chinese_level: 'native' as const, years: 6, headline: '이번 지원용', contact_email: 'h2@example.test', phone: null, desired_role: null, experience_text: '고친 경력' };
  it('이번 지원에만 고친 항목이 들어가고, 원본은 바뀌지 않는다', () => {
    const snap = buildSnapshot(base, edited, { include: true, copied: true });
    expect(snap).toEqual({ v: 1, ...edited, file: base.file });
    expect(base.headline).toBe('원본');
  });
  it('첨부를 빼기로 했거나 복사에 실패했으면 파일 정보를 남기지 않는다', () => {
    expect(buildSnapshot(base, edited, { include: false, copied: true }).file).toBeNull();
    expect(buildSnapshot(base, edited, { include: true, copied: false }).file).toBeNull();
    expect(buildSnapshot({ ...base, file: null }, edited, { include: true, copied: true }).file).toBeNull();
  });
});

describe('취소', () => {
  it('진행 중인 지원만 취소할 수 있다 (nextStatus 와 같은 뜻)', () => {
    expect(WITHDRAWABLE).toEqual(['submitted', 'viewed', 'reviewing', 'interview']);
    for (const s of ['submitted', 'viewed', 'reviewing', 'interview'] as const) {
      expect(canWithdraw(s)).toBe(true);
      expect(nextStatus(s, 'withdrawn')).toBe('withdrawn');
    }
    for (const s of ['rejected', 'closed', 'withdrawn', 'bogus']) expect(canWithdraw(s)).toBe(false);
  });
});

describe('기업 알림 메일', () => {
  it('공고 제목과 주소만 들어간다 (한국어 + 중국어)', () => {
    const m = newApplicantMail({ title_ko: '영업 매니저\n채용' }, 'https://x.test/', t);
    expect(m.subject).toContain('영업 매니저 채용');
    expect(m.text).toContain('https://x.test/biz');
    expect(m.text.indexOf('영업 매니저')).toBeLessThan(m.text.lastIndexOf('영업 매니저'));
    expect(m.subject + m.text).not.toContain('@');
    expect(m.subject + m.text).not.toMatch(/\{(site|url|job)\}/);
    for (const banned of ['취업상담', '취업추천', '취업지원', '취업알선']) expect(m.subject + m.text).not.toContain(banned);
  });
});

describe.skipIf(!hasSqlite)('지원 DB 문장', () => {
  const setup = () => {
    const { raw, d1 } = migratedDb();
    raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
      ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0),
      ('m1','m1@example.test','company','active',0), ('m2','m2@example.test','company','active',0), ('m3','m3@example.test','company','suspended',0)`);
    raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES
      ('c1','가짜전자','kr_entity','verified',0), ('c2','미검증','kr_entity','pending',0)`);
    raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','m1','owner',0,0), ('c1','m2','member',1,0), ('c1','m3','member',0,0)`);
    raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, created_at, updated_at) VALUES
      ('j1','c1','m1','office','영업','본문','approved','published',1,0,0),
      ('j2','c1','m1','office','초안','본문','approved','draft',NULL,0,0),
      ('j3','c2','m1','office','미검증기업','본문','approved','published',1,0,0),
      ('j4','c1','m1','office','마감지남','본문','approved','published',1,0,0)`);
    raw.exec("UPDATE jobs SET closes_at = 50 WHERE id = 'j4'");
    return { raw, d1 };
  };
  const apply = (d1: D1Database, p: Partial<Parameters<typeof insertApplication>[1]> = {}) =>
    insertApplication(d1, { id: 'a1', jobId: 'j1', seekerId: 's1', resumeId: 'r1', snapshot: 'v1.x.y', fileKey: 'rfiles/k1', consentAt: null, consentVersion: CROSS_BORDER_VERSION, ts: 100, ...p }, FLAGS);

  it('공개 중인 공고에만 지원이 들어간다', async () => {
    const { d1 } = setup();
    expect(await apply(d1, { id: 'x2', jobId: 'j2' })).toBe(false);     // 초안
    expect(await apply(d1, { id: 'x3', jobId: 'j3' })).toBe(false);     // 미검증 기업
    expect(await apply(d1, { id: 'x4', jobId: 'j4' })).toBe(false);     // 마감일 지남
    expect(await apply(d1, { id: 'x5', jobId: 'nope' })).toBe(false);
    expect(await apply(d1)).toBe(true);
    expect(await getOwnApplication(d1, 'a1', 's1')).toMatchObject({ job_id: 'j1', status: 'submitted', resume_snapshot: 'v1.x.y', file_r2_key: 'rfiles/k1', cross_border_consent_at: null });
    expect(await hasApplied(d1, 'j1', 's1')).toBe(true);
    expect(await hasApplied(d1, 'j1', 's2')).toBe(false);
  });
  it('같은 공고에 두 번 지원할 수 없다 (다른 구직자는 가능)', async () => {
    const { d1 } = setup();
    expect(await apply(d1)).toBe(true);
    expect(await apply(d1, { id: 'a2' })).toBe(false);
    expect(await apply(d1, { id: 'a3', seekerId: 's2' })).toBe(true);
  });
  it('국외 이전 동의는 지원이 들어갔을 때만 기록된다', async () => {
    const { raw, d1 } = setup();
    expect(await apply(d1, { id: 'x2', jobId: 'j2', consentAt: 100 })).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM consents').get()!.n).toBe(0);
    expect(await apply(d1, { consentAt: 100 })).toBe(true);
    expect({ ...raw.prepare("SELECT user_id, type, version, ref_id, agreed_at, withdrawn_at FROM consents").get()! })
      .toEqual({ user_id: 's1', type: 'cross_border', version: CROSS_BORDER_VERSION, ref_id: 'a1', agreed_at: 100, withdrawn_at: null });
    expect((await getOwnApplication(d1, 'a1', 's1'))?.cross_border_consent_at).toBe(100);
  });
  it('남의 지원은 읽지도 취소하지도 못한다', async () => {
    const { d1 } = setup();
    await apply(d1);
    expect(await getOwnApplication(d1, 'a1', 's2')).toBeNull();
    expect(await withdrawApplication(d1, { id: 'a1', seekerId: 's2', newStatus: 'withdrawn', fromStatuses: WITHDRAWABLE, ts: 200 })).toBe(false);
    expect((await getOwnApplication(d1, 'a1', 's1'))?.status).toBe('submitted');
  });
  it('취소: 이벤트가 남고, 내용·파일 키가 지워지고, 동의가 철회되며, 두 번은 안 된다', async () => {
    const { raw, d1 } = setup();
    await apply(d1, { consentAt: 100 });
    expect(await withdrawApplication(d1, { id: 'a1', seekerId: 's1', newStatus: nextStatus('submitted', 'withdrawn'), fromStatuses: WITHDRAWABLE, ts: 200 })).toBe(true);
    expect(await getOwnApplication(d1, 'a1', 's1')).toMatchObject({ status: 'withdrawn', status_changed_at: 200, resume_snapshot: '', file_r2_key: null });
    expect({ ...raw.prepare('SELECT application_id, event, actor_id, at FROM application_events').get()! }).toEqual({ application_id: 'a1', event: 'withdrawn', actor_id: 's1', at: 200 });
    expect(raw.prepare('SELECT withdrawn_at FROM consents').get()!.withdrawn_at).toBe(200);
    expect(await withdrawApplication(d1, { id: 'a1', seekerId: 's1', newStatus: 'withdrawn', fromStatuses: WITHDRAWABLE, ts: 300 })).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM application_events').get()!.n).toBe(1);
    // 취소한 공고에는 다시 지원할 수 없다
    expect(await apply(d1, { id: 'a9' })).toBe(false);
  });
  it('이미 끝난 지원(불합격 등)은 취소되지 않는다', async () => {
    const { raw, d1 } = setup();
    await apply(d1);
    raw.exec("UPDATE applications SET status = 'rejected' WHERE id = 'a1'");
    expect(await withdrawApplication(d1, { id: 'a1', seekerId: 's1', newStatus: 'withdrawn', fromStatuses: WITHDRAWABLE, ts: 200 })).toBe(false);
    expect(await getOwnApplication(d1, 'a1', 's1')).toMatchObject({ status: 'rejected', resume_snapshot: 'v1.x.y' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM application_events').get()!.n).toBe(0);
  });
  it('내 지원 현황: 공고가 내려가도 기록은 남고, 남의 것은 안 보인다', async () => {
    const { raw, d1 } = setup();
    await apply(d1); await apply(d1, { id: 'b1', seekerId: 's2' });
    raw.exec("UPDATE jobs SET status = 'closed' WHERE id = 'j1'");
    const mine = await listOwnApplications(d1, 's1');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 'a1', job_id: 'j1', status: 'submitted', title_ko: '영업', company_name: '가짜전자' });
    raw.exec("UPDATE jobs SET company_name_public = 0 WHERE id = 'j1'");
    expect((await listOwnApplications(d1, 's1'))[0]!.company_name).toBeNull();
  });
  it('담당자 수와 알림 주소 (정지된 계정 제외)', async () => {
    const { d1 } = setup();
    expect(await memberCounts(d1, 'c1')).toEqual({ hqMembers: 1, localMembers: 2 });
    expect(await memberCounts(d1, 'none')).toEqual({ hqMembers: 0, localMembers: 0 });
    expect((await companyMemberEmails(d1, 'c1')).sort()).toEqual(['m1@example.test', 'm2@example.test']);
  });
});

// ── 첨부파일 내려받기
function fakeEnv() {
  const store = new Map<string, Uint8Array>();
  const logs: unknown[][] = [];
  const env = {
    ENC_KEY: b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/'),
    FILES: {
      put: async (k: string, v: Uint8Array) => { store.set(k, v); },
      get: async (k: string) => { const v = store.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
      delete: async (k: string) => { store.delete(k); },
    },
    DB: { prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ run: async () => { logs.push([sql, ...b]); return { meta: { changes: 1 } }; } }) }) },
  } as unknown as Env;
  return { env, logs };
}

describe('지원서 첨부파일 내려받기', () => {
  const meta = { name: '이력서.pdf', ext: 'pdf' as const, mime: 'application/pdf', size: 0 };
  const pdf = new TextEncoder().encode('%PDF-1.4 fake');
  const mkApp = async (env: Env, p: Partial<ApplicationRef> = {}) => ({ ...ref(p), id: 'a1', file_r2_key: await putResumeFile(env, pdf) });

  it('본인과 그 기업의 한국 담당자는 받고, 기록이 남는다', async () => {
    const { env, logs } = fakeEnv();
    const app = await mkApp(env);
    const mine = await serveApplicationFile(env, mk({ role: 'seeker', id: 's1' }), app, meta, null);
    expect(new Uint8Array(await mine!.arrayBuffer())).toEqual(pdf);
    expect(mine!.headers.get('content-disposition')).toContain('attachment');
    expect(await serveApplicationFile(env, mk({ id: 'm1', companyIds: ['c1'] }), app, meta, null)).not.toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toEqual(expect.arrayContaining(['m1', 'company', 'application', 'a1']));
  });
  it('다른 기업·다른 구직자·동의 없는 본사 담당자는 받지 못하고 기록도 없다', async () => {
    const { env, logs } = fakeEnv();
    const app = await mkApp(env);
    expect(await serveApplicationFile(env, mk({ companyIds: ['c2'] }), app, meta, null)).toBeNull();
    expect(await serveApplicationFile(env, mk({ role: 'seeker', id: 's2' }), app, meta, null)).toBeNull();
    expect(await serveApplicationFile(env, mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] }), app, meta, null)).toBeNull();
    expect(logs).toHaveLength(0);
    const consented = await mkApp(env, { cross_border_consent_at: 5 });
    expect(await serveApplicationFile(env, mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] }), consented, meta, null)).not.toBeNull();
  });
  it('취소된 지원의 파일은 기업·관리자가 받지 못한다', async () => {
    const { env, logs } = fakeEnv();
    const app = await mkApp(env, { status: 'withdrawn' });
    expect(await serveApplicationFile(env, mk({ companyIds: ['c1'] }), app, meta, null)).toBeNull();
    expect(await serveApplicationFile(env, mk({ role: 'admin' }), app, meta, '사유')).toBeNull();
    expect(logs).toHaveLength(0);
  });
  it('관리자는 사유가 있어야 하고, 사유가 기록된다', async () => {
    const { env, logs } = fakeEnv();
    const app = await mkApp(env);
    expect(await serveApplicationFile(env, mk({ role: 'admin', id: 'adm' }), app, meta, ' ')).toBeNull();
    expect(await serveApplicationFile(env, mk({ role: 'admin', id: 'adm' }), app, meta, '신고 확인')).not.toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.arrayContaining(['adm', 'admin', 'application', 'a1', '신고 확인']));
  });
});
