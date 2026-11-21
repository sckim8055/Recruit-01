// 공고(jobs) 읽기·쓰기 (기업·관리자 화면 공통). 판단은 하지 않는다 — 권한은 authz.ts, 게재 가능 여부는 rules.publishBlocks,
// 저장 시 상태 계산은 lib/jobs.planJobSave. 여기의 WHERE 는 "그사이 바뀔 수 있는 사실" 만 다시 확인하는 가드이며 옮기기 전과 같다.
// 쓰기 함수는 영향 행 수가 1 이면 true 를 돌려준다 (호출부의 판단은 옮기기 전과 같다).
//
// [sqlite] meta.changes(영향 행 수) → PostgreSQL 드라이버의 rowCount.
import type { JobFamily, JobStatus, LocalizeStatus } from '../lib/jobs';
import type { AdminJobListRow } from '../views/admin-jobs';
import type { JobListRow } from '../views/jobs';

export interface JobRow {
  id: string;
  company_id: string;
  agency_id: string | null;
  created_by: string;
  job_family: JobFamily;
  title_zh: string | null;
  source_zh: string | null;
  title_ko: string | null;
  body_ko: string | null;
  back_zh: string | null;
  localize_status: LocalizeStatus;
  localize_engine: string | null;
  localize_requested_at: number | null;
  role_category: string | null;
  industry: string | null;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_basis: string | null;
  work_hours: string | null;
  report_line: string | null;
  chinese_level: string | null;
  contact_email: string | null;
  review_flag: string | null;
  review_cleared_by: string | null;
  status: JobStatus;
  block_reason: string | null;
  published_at: number | null;
  closes_at: number | null;
  created_at: number;
  updated_at: number;
  rev: number;
}

export const JOB_COLS =
  'id, company_id, agency_id, created_by, job_family, title_zh, source_zh, title_ko, body_ko, back_zh, localize_status, localize_engine, ' +
  'localize_requested_at, role_category, industry, location, salary_min, salary_max, salary_basis, work_hours, report_line, chinese_level, ' +
  'contact_email, review_flag, review_cleared_by, status, block_reason, published_at, closes_at, created_at, updated_at, rev';

export const loadJob = (db: D1Database, id: string) => db.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?`).bind(id).first<JobRow>();

/** 폼에서 받는 구조 항목 (JobFields) 으로 바꿀 때 쓰는 기본값: DB 의 NULL 원문은 빈 문자열로. */
export const jobFieldsOf = (j: JobRow) => ({
  title_zh: j.title_zh ?? '', source_zh: j.source_zh ?? '', job_family: j.job_family, role_category: j.role_category,
  industry: j.industry, location: j.location, salary_min: j.salary_min, salary_max: j.salary_max, salary_basis: j.salary_basis,
  work_hours: j.work_hours, report_line: j.report_line, chinese_level: j.chinese_level, contact_email: j.contact_email, closes_at: j.closes_at,
});

/** 저장할 구조 항목 (lib/jobs.validateJob 의 결과). */
export interface JobValues {
  job_family: string; title_zh: string; source_zh: string; role_category: string | null; industry: string | null; location: string | null;
  salary_min: number | null; salary_max: number | null; salary_basis: string | null; work_hours: string | null; report_line: string | null;
  chinese_level: string | null; contact_email: string | null; closes_at: number | null;
}

/** 저장 후 상태 (lib/jobs.planJobSave 의 결과). */
export interface JobSavePlan { status: string; localize_status: string; review_flag: string | null; review_cleared_by: string | null }

// ── 기업 화면 (routes/biz-jobs.tsx)

export async function listCompanyJobs(db: D1Database, companyId: string): Promise<JobListRow[]> {
  const r = await db.prepare(
    `SELECT id, title_zh, title_ko, status, localize_status, review_flag, review_cleared_by, updated_at
     FROM jobs WHERE company_id = ? AND agency_id IS NULL ORDER BY updated_at DESC LIMIT 200`,
  ).bind(companyId).all<JobListRow>();
  return r.results;
}

export async function insertJob(
  db: D1Database, x: { id: string; companyId: string; createdBy: string; v: JobValues; reviewFlag: string | null; ts: number },
): Promise<void> {
  const v = x.v;
  await db.prepare(
    `INSERT INTO jobs (id, company_id, agency_id, created_by, job_family, title_zh, source_zh, localize_status, role_category, industry,
       location, salary_min, salary_max, salary_basis, work_hours, report_line, chinese_level, contact_email, review_flag,
       status, closes_at, created_at, updated_at, rev)
     VALUES (?,?,NULL,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,0)`,
  ).bind(
    x.id, x.companyId, x.createdBy, v.job_family, v.title_zh, v.source_zh, v.role_category, v.industry, v.location,
    v.salary_min, v.salary_max, v.salary_basis, v.work_hours, v.report_line, v.chinese_level, v.contact_email, x.reviewFlag,
    v.closes_at, x.ts, x.ts,
  ).run();
}

/** 원문·조건 저장. 읽은 rev·상태가 그대로이고, 게재 상태로 남기려면 기업이 아직 검증 완료일 때만. */
export async function updateJobSource(
  db: D1Database, x: { v: JobValues; plan: JobSavePlan; ts: number; id: string; rev: number; readStatus: string },
): Promise<boolean> {
  const { v, plan } = x;
  const res = await db.prepare(
    `UPDATE jobs SET title_zh = ?, source_zh = ?, job_family = ?, role_category = ?, industry = ?, location = ?, salary_min = ?,
       salary_max = ?, salary_basis = ?, work_hours = ?, report_line = ?, chinese_level = ?, contact_email = ?, closes_at = ?,
       status = ?, localize_status = ?, review_flag = ?, review_cleared_by = ?, rev = rev + 1, updated_at = ?
     WHERE id = ? AND rev = ? AND status = ?
       AND (? != 'published' OR EXISTS (SELECT 1 FROM companies WHERE id = jobs.company_id AND verify_status = 'verified'))`,
  ).bind(
    v.title_zh, v.source_zh, v.job_family, v.role_category, v.industry, v.location, v.salary_min, v.salary_max, v.salary_basis,
    v.work_hours, v.report_line, v.chinese_level, v.contact_email, v.closes_at,
    plan.status, plan.localize_status, plan.review_flag, plan.review_cleared_by, x.ts,
    x.id, x.rev, x.readStatus, plan.status,
  ).run();
  return res.meta.changes === 1;
}

/**
 * 현지화 호출 자리 잡기: 짧은 간격으로 반복 호출하지 못하게 먼저 시각을 기록한다 (한 문장으로 확인과 기록을 같이).
 * notAfter = ts - 최소 간격 (호출부가 계산한다).
 */
export async function claimLocalize(db: D1Database, x: { ts: number; id: string; rev: number; notAfter: number }): Promise<boolean> {
  const claim = await db.prepare(
    `UPDATE jobs SET localize_requested_at = ? WHERE id = ? AND rev = ? AND (localize_requested_at IS NULL OR localize_requested_at <= ?)`,
  ).bind(x.ts, x.id, x.rev, x.notAfter).run();
  return claim.meta.changes === 1;
}

/** 엔진 결과 저장. 엔진을 부르는 동안 원문이 바뀌었으면(rev·상태가 다르면) 반영하지 않는다. */
export async function saveLocalized(
  db: D1Database,
  x: { title_ko: string; body_ko: string; back_zh: string | null; engine: string; plan: JobSavePlan; ts: number; id: string; rev: number; readStatus: string },
): Promise<boolean> {
  const plan = x.plan;
  const res = await db.prepare(
    `UPDATE jobs SET title_ko = ?, body_ko = ?, back_zh = ?, localize_engine = ?, status = ?, localize_status = ?,
       review_flag = ?, review_cleared_by = ?, rev = rev + 1, updated_at = ?
     WHERE id = ? AND rev = ? AND status = ?
       AND (? != 'published' OR EXISTS (SELECT 1 FROM companies WHERE id = jobs.company_id AND verify_status = 'verified'))`,
  ).bind(
    x.title_ko, x.body_ko, x.back_zh, x.engine, plan.status, plan.localize_status, plan.review_flag, plan.review_cleared_by, x.ts,
    x.id, x.rev, x.readStatus, plan.status,
  ).run();
  return res.meta.changes === 1;
}

/** 한국어 직접 입력 저장. back_zh 는 호출부가 정한다 (한국어가 바뀌면 null). */
export async function saveKorean(
  db: D1Database,
  x: { title_ko: string; body_ko: string; back_zh: string | null; plan: JobSavePlan; ts: number; id: string; rev: number; readStatus: string },
): Promise<boolean> {
  const plan = x.plan;
  const res = await db.prepare(
    `UPDATE jobs SET title_ko = ?, body_ko = ?, back_zh = ?, status = ?, localize_status = ?, review_flag = ?, review_cleared_by = ?,
       rev = rev + 1, updated_at = ?
     WHERE id = ? AND rev = ? AND status = ?
       AND (? != 'published' OR EXISTS (SELECT 1 FROM companies WHERE id = jobs.company_id AND verify_status = 'verified'))`,
  ).bind(
    x.title_ko, x.body_ko, x.back_zh, plan.status, plan.localize_status, plan.review_flag, plan.review_cleared_by, x.ts,
    x.id, x.rev, x.readStatus, plan.status,
  ).run();
  return res.meta.changes === 1;
}

export async function approveJob(db: D1Database, x: { id: string; rev: number }): Promise<boolean> {
  const res = await db.prepare(
    "UPDATE jobs SET localize_status = 'approved' WHERE id = ? AND rev = ? AND localize_status = 'review'",
  ).bind(x.id, x.rev).run();
  return res.meta.changes === 1;
}

/**
 * 게재. 호출 전에 rules.publishBlocks 가 빈 배열이어야 한다 (CLAUDE.md 규칙 2 — 호출부가 확인한다).
 * WHERE 는 publishBlocks 가 본 사실 중 그사이 바뀔 수 있는 것만 다시 확인한다:
 * 상태·내용 버전(rev: 글·연락처·연봉 등 모든 항목)·승인·관리자 검토·기업 검증.
 */
export async function publishJob(db: D1Database, x: { ts: number; id: string; rev: number }): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE jobs SET status = 'published', published_at = ?
     WHERE id = ? AND rev = ? AND status = 'draft' AND localize_status = 'approved'
       AND (review_flag IS NULL OR review_cleared_by IS NOT NULL)
       AND EXISTS (SELECT 1 FROM companies WHERE id = jobs.company_id AND verify_status = 'verified')`,
  ).bind(x.ts, x.id, x.rev).run();
  return res.meta.changes === 1;
}

/** 마감: 게재 중 → 마감. */
export async function closeJob(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE jobs SET status = 'closed' WHERE id = ? AND status = 'published'").bind(id).run();
  return res.meta.changes === 1;
}

// ── 관리자 화면 (routes/admin-jobs.tsx). 내용 수정·게재 함수는 없다.

/**
 * 검토 대기·차단 공고.
 * ORDER BY j.status = 'blocked' 는 참/거짓 정렬이다. SQLite 는 0/1, PostgreSQL 은 false/true 로 정렬 순서가 같다.
 */
export async function listJobsForAdmin(db: D1Database): Promise<AdminJobListRow[]> {
  const r = await db.prepare(
    `SELECT j.id, j.title_ko, j.title_zh, j.status, j.review_flag, j.review_cleared_by, j.updated_at, c.name_ko AS company_name
     FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE (j.review_flag IS NOT NULL AND j.review_cleared_by IS NULL AND j.status IN ('draft','published')) OR j.status = 'blocked'
     ORDER BY j.status = 'blocked', j.updated_at DESC LIMIT 500`,
  ).all<AdminJobListRow>();
  return r.results;
}

/** 검토 통과: 화면에서 본 rev 가 그대로이고 아직 통과 전일 때만. */
export async function clearJobReview(db: D1Database, x: { adminId: string; id: string; rev: number }): Promise<boolean> {
  const res = await db.prepare(
    'UPDATE jobs SET review_cleared_by = ? WHERE id = ? AND rev = ? AND review_flag IS NOT NULL AND review_cleared_by IS NULL',
  ).bind(x.adminId, x.id, x.rev).run();
  return res.meta.changes === 1;
}

export async function blockJob(db: D1Database, x: { reason: string; id: string }): Promise<boolean> {
  const res = await db.prepare("UPDATE jobs SET status = 'blocked', block_reason = ? WHERE id = ? AND status != 'blocked'")
    .bind(x.reason, x.id).run();
  return res.meta.changes === 1;
}

/** 차단 해제: 초안으로 되돌린다 (게재는 기업이 다시 publishBlocks 를 거쳐야 한다). */
export async function unblockJob(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE jobs SET status = 'draft', block_reason = NULL WHERE id = ? AND status = 'blocked'")
    .bind(id).run();
  return res.meta.changes === 1;
}
