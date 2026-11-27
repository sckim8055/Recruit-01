// 동시성 (T-19, docs/DB-PORTING.md 4장): src/db 의 "한 문장 가드"·batch 가 실제 PostgreSQL 16 에서 여러 연결로 동시에 불려도
// D1(쓰기를 차례로 함)과 같은 결과인지 본다. 서버와 같은 어댑터(src/db/pg.ts: SERIALIZABLE + 40001 다시 실행)를 쓴다.
// PGlite 는 연결이 하나라 시험할 수 없어 PG_TEST_URL(예: postgres://postgres@127.0.0.1:5433/postgres)이 있을 때만 돈다.
// 시험마다 새 스키마를 만들고 끝나면 지운다. 가짜 데이터만.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, createPool, poolBackend } from '../src/db/pg';
import type { Db } from '../src/db/types';
import { pgSchemaSql } from './pg-test-db';
import { readUsage, takeQuota } from '../src/db/usage';
import { takeTotpTry, useRecoveryCode } from '../src/db/twofa';
import { useTotpStep } from '../src/db/users';
import { consumeTotpPending, insertTotpPending } from '../src/db/sessions';
import { insertApplication, withdrawApplication } from '../src/db/applications';
import { insertResume } from '../src/db/resumes';
import { claimLocalize, insertJob, type JobValues } from '../src/db/jobs';
import { insertAlert } from '../src/db/alerts';
import { acceptInvite, insertInviteWithinLimit, registerCompany } from '../src/db/companies';
import { setOptionActive } from '../src/db/options';
import { markViewed, recordMailEvent } from '../src/db/applicants';
import { insertConsents } from '../src/db/consents';
import { MAINT_LOCK_KEY, withAdvisoryLock } from '../src/db/locks';

const URL_ = process.env.PG_TEST_URL ?? '';
const N = 12;
const FLAGS = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
const parallel = <T>(n: number, f: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => f(i)));
const trues = (xs: unknown[]) => xs.filter((x) => x === true || x === 1 || x === 'ok').length;

describe.skipIf(!URL_)('PostgreSQL 동시성 (PG_TEST_URL)', () => {
  const schema = `cc_${process.pid}_${Date.now()}`;
  let admin: pg.Client;
  let pool: Awaited<ReturnType<typeof createPool>>;
  let db: Db;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as Record<string, unknown>[];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(pgSchemaSql());
    // PG_TEST_ISOLATION='read committed' 은 비교 실험용 (docs/DB-PORTING.md 4장의 "READ COMMITTED 였다면" 열). 평소에는 서버와 같은 serializable.
    const isolation = process.env.PG_TEST_ISOLATION === 'read committed' ? 'read committed' : 'serializable';
    pool = await createPool({ connectionString: URL_, max: N, isolation, extraOptions: `-c search_path=${schema}` });
    db = createDb(poolBackend(pool));
    await q(`INSERT INTO users (id, email, role, created_at, totp_secret) VALUES
      ('s1','s1@example.test','seeker',0,'v1.enc.secret'), ('co','co@example.test','company',0,NULL), ('adm','adm@example.test','admin',0,NULL),
      ('nu','nu@example.test','company',0,NULL)`);
    await q(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜','kr_entity','verified',0), ('c2','가짜2','kr_entity','verified',0)`);
    await q(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','co','owner',0,0)`);
    await q(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, status, localize_status, published_at, created_at, updated_at, rev)
             VALUES ('j1','c1','co','office','t','published','approved',1,0,0,0)`);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('연결은 SERIALIZABLE 로 열린다', async () => {
    expect((await q('SHOW default_transaction_isolation'))[0]!.default_transaction_isolation).toBe('serializable');
  });

  it('usage.takeQuota: 한도 5 에 12번 동시에 → 5번만 true, 합계 5 (첫 행을 동시에 넣는 경우 포함)', async () => {
    const key = { scope: 'mail_company', subject: 'c1', day: '2026-11-27' };
    const r = await parallel(N, () => takeQuota(db, { ...key, limit: 5, ts: 1 }));
    expect(trues(r)).toBe(5);
    expect(await readUsage(db, key)).toBe(5);
  });

  it('twofa.useRecoveryCode: 같은 코드 12번 동시에 → 1번만 true', async () => {
    await q("INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES ('rc1','s1','H1',NULL,0), ('rc2','s1','H1',NULL,0)");
    // 같은 해시가 두 줄이면 두 번까지 쓸 수 있다 (LIMIT 1 씩) — 그 이상은 안 된다
    const r = await parallel(N, () => useRecoveryCode(db, 's1', 'H1', 5));
    expect(trues(r)).toBe(2);
    expect(Number((await q("SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE used_at IS NOT NULL"))[0]!.n)).toBe(2);
  });

  it('users.useTotpStep: 같은 단계 12번 동시에 → 1번만 true', async () => {
    const r = await parallel(N, () => useTotpStep(db, 's1', 'v1.enc.secret', 1000));
    expect(trues(r)).toBe(1);
  });

  it('sessions.consumeTotpPending: 같은 대기 12번 동시에 → 1번만 true', async () => {
    await insertTotpPending(db, 'p1', 's1', 9_999_999_999, 'seeker');
    expect(trues(await parallel(N, () => consumeTotpPending(db, 'p1')))).toBe(1);
  });

  it('twofa.takeTotpTry: 15분에 5번 — 12번 동시에 → 5번만 true', async () => {
    expect(trues(await parallel(N, () => takeTotpTry(db, 's1', 100, 50, 5)))).toBe(5);
  });

  it('applications.insertApplication: 같은 공고·같은 구직자 12번 동시에 → 1건', async () => {
    const r = await parallel(N, (i) => insertApplication(db, {
      id: `a${i}`, jobId: 'j1', seekerId: 's1', resumeId: 'r', snapshot: 'v1.x.y', fileKey: null, consentAt: 1, consentVersion: 'v1', ts: 10, keepDays: 180,
    }, FLAGS));
    expect(trues(r)).toBe(1);
    expect(Number((await q('SELECT COUNT(*) AS n FROM applications'))[0]!.n)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM consents WHERE type = 'cross_border'"))[0]!.n)).toBe(1);
  });

  it('applicants.markViewed · recordMailEvent · withdrawApplication: 이벤트와 상태가 한 번씩만', async () => {
    const app = String((await q('SELECT id FROM applications'))[0]!.id);
    expect(trues(await parallel(N, () => markViewed(db, { id: app, actorId: 'co', from: 'submitted', to: 'viewed', ts: 11 })))).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM application_events WHERE event = 'viewed'"))[0]!.n)).toBe(1);
    const mails = await parallel(N, () => recordMailEvent(db, { id: app, actorId: 'co', event: 'interview_mail', from: 'viewed', to: 'interview', maxSame: 3, ts: 12 }));
    // 첫 메일이 상태를 viewed → interview 로 옮기면 그 뒤 from = viewed 인 요청은 들어가지 않는다 → 정확히 1
    expect(trues(mails)).toBe(1);
    const w = await parallel(N, () => withdrawApplication(db, { id: app, seekerId: 's1', newStatus: 'withdrawn', fromStatuses: ['submitted', 'viewed', 'reviewing', 'interview'], ts: 13 }));
    expect(trues(w)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM application_events WHERE event = 'withdrawn'"))[0]!.n)).toBe(1);
  });

  it('resumes.insertResume: 5개 한도 — 12번 동시에 → 5개, 대표는 하나', async () => {
    const r = await parallel(N, (i) => insertResume(db, { id: `res${i}`, userId: 's1', title: 't', body: 'v1.a.b', fileKey: null, ts: i }, 5));
    expect(trues(r)).toBe(5);
    expect(Number((await q("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1'"))[0]!.n)).toBe(5);
    expect(Number((await q("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1' AND is_default = 1"))[0]!.n)).toBe(1);
  });

  it('jobs.insertJob: 작성 중 공고 3개 한도 — 12번 동시에 → 3개', async () => {
    const v: JobValues = {
      job_family: 'office', title_zh: 't', source_zh: 's', role_category: null, industry: null, location: null, salary_min: null, salary_max: null,
      salary_basis: null, work_hours: null, report_line: null, chinese_level: null, contact_email: null, closes_at: null,
    };
    const r = await parallel(N, (i) => insertJob(db, { id: `jd${i}`, companyId: 'c1', createdBy: 'co', v, reviewFlag: null, ts: 1, maxDrafts: 3 }));
    expect(trues(r)).toBe(3);
  });

  it('jobs.claimLocalize: 같은 공고 12번 동시에 → 1번', async () => {
    expect(trues(await parallel(N, () => claimLocalize(db, { ts: 100, id: 'j1', rev: 0, notAfter: 80 })))).toBe(1);
  });

  it('alerts.insertAlert: 5개 한도 · 같은 조건은 한 번', async () => {
    const base = { seekerId: 's1', frequency: 'daily', now: 1, nextDue: 2, optinVersion: 'v1', max: 5 };
    const r = await parallel(N, (i) => insertAlert(db, { ...base, id: `al${i}`, filterJson: `{"location":"x${i}"}` }));
    expect(r.filter((x) => x === 'ok').length).toBe(5);
    await q("DELETE FROM alerts");
    const d = await parallel(N, (i) => insertAlert(db, { ...base, id: `ad${i}`, filterJson: '{"location":"same"}' }));
    expect(d.filter((x) => x === 'ok').length).toBe(1);
  });

  it('companies.insertInviteWithinLimit: 자리 3 (담당자 1) — 12번 동시에 → 초대 2건', async () => {
    const r = await parallel(N, (i) => insertInviteWithinLimit(db, { id: `iv${i}`, companyId: 'c1', email: `x${i}@example.test`, isHq: 0, invitedBy: 'co', ts: 1, maxSeats: 3 }));
    expect(r.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('companies.registerCompany: 같은 사람이 12번 동시에 → 기업 하나·소속 하나', async () => {
    const r = await parallel(N, (i) => registerCompany(db, {
      id: `nc${i}`, name_ko: '새기업', name_zh: null, biz_no: null, entity_type: 'kr_entity', hq_name: null, entry_stage: null, industry: null, website: null,
      ts: 1, userId: 'nu', ownerIsHq: 0,
    }));
    expect(trues(r)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM company_members WHERE user_id = 'nu'"))[0]!.n)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM companies WHERE id LIKE 'nc%'"))[0]!.n)).toBe(1);
  });

  it('companies.acceptInvite: 두 기업의 초대를 동시에 수락 → 한 기업에만 소속', async () => {
    await q("INSERT INTO users (id, email, role, created_at) VALUES ('inv','inv@example.test','company',0)");
    await q(`INSERT INTO company_invites (id, company_id, email, is_hq, invited_by, created_at) VALUES
      ('ia','c1','inv@example.test',0,'co',0), ('ib','c2','inv@example.test',0,'co',0)`);
    const r = await parallel(N, (i) => acceptInvite(db, { userId: 'inv', ts: 1, inviteId: i % 2 ? 'ia' : 'ib', email: 'inv@example.test' }));
    expect(trues(r)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM company_members WHERE user_id = 'inv'"))[0]!.n)).toBe(1);
  });

  it('options.setOptionActive: 사용 중 둘을 동시에 끄면 하나는 남는다', async () => {
    await q("UPDATE job_options SET active = 0 WHERE kind = 'location' AND code NOT IN ('seoul','busan')");
    const r = await parallel(N, (i) => setOptionActive(db, { kind: 'location', code: i % 2 ? 'seoul' : 'busan', active: false, userId: 'adm', ts: 1 }));
    expect(trues(r)).toBe(1);
    expect(Number((await q("SELECT COUNT(*) AS n FROM job_options WHERE kind = 'location' AND active = 1"))[0]!.n)).toBe(1);
  });

  it('consents.insertConsents: 같은 판의 동의가 두 줄 생기지 않는다', async () => {
    await parallel(N, () => insertConsents(db, 'co', [{ type: 'terms', version: 'tv' }, { type: 'privacy', version: 'pv' }], 1));
    expect(Number((await q("SELECT COUNT(*) AS n FROM consents WHERE user_id = 'co'"))[0]!.n)).toBe(2);
  });

  it('예약 작업 잠금: 동시에 두 번 → 하나만 잡는다', async () => {
    let inside = 0, max = 0;
    const r = await parallel(4, () => withAdvisoryLock(pool, MAINT_LOCK_KEY, async () => {
      inside++; max = Math.max(max, inside);
      await new Promise((res) => setTimeout(res, 100));
      inside--;
      return 1;
    }));
    expect(r.filter((x) => x.acquired).length).toBe(1);
    expect(max).toBe(1);
    // 풀린 뒤에는 다시 잡힌다
    expect((await withAdvisoryLock(pool, MAINT_LOCK_KEY, async () => 2)).acquired).toBe(true);
  });
});
