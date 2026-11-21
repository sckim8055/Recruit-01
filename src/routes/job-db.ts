// 공고 행 읽기 (기업·관리자 화면 공통). 판단은 하지 않는다 — 권한은 authz.ts, 게재 가능 여부는 rules.publishBlocks.
import type { JobFamily, JobStatus, LocalizeStatus } from '../lib/jobs';

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
