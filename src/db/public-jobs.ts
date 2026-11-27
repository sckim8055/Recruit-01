// 공개 공고 목록·상세 (routes/jobs.tsx, 홈). 읽기만 한다.
// - 공개 조건은 publicJobWhere() 하나로 만든다. 뜻은 lib/public-jobs.isPubliclyVisible 과 같다 (test/public-jobs.test.ts 가 비교).
// - 공개 화면에 보일 컬럼만 고른다. source_zh·title_zh·back_zh·review_flag·block_reason·localize_engine·status 등은 읽지 않는다.
// - 기업명 비공개(company_name_public = 0) 공고는 기업 이름·id 를 SQL 에서부터 NULL 로 돌려준다 (화면이 실수로 보일 수 없게).
// - 필터 값은 lib/public-jobs.parseJobFilter 를 거친 목록 안의 값이며, 여기서도 바인딩 매개변수로만 쓴다.
//   컬럼 이름은 아래 FILTER_COLUMNS 의 고정 목록에서만 온다.
//
// [sqlite] jobs.company_name_public 은 INTEGER 0/1 (`= 1` 로 비교). PostgreSQL 에서 boolean 으로 바꾸면 이 비교를 고친다.
import type { Flags } from '../env';
import { FILTER_KEYS, type FilterKey, type JobFilter } from '../lib/public-jobs';
import type { Db } from './types';

export interface PublicJobListRow {
  id: string;
  title_ko: string | null;
  company_id: string | null;      // 기업명 비공개면 NULL
  company_name: string | null;    // 기업명 비공개면 NULL
  entry_stage: string | null;
  location: string | null;
  role_category: string | null;
  industry: string | null;
  chinese_level: string | null;
  report_line: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_basis: string | null;
  closes_at: number | null;
  published_at: number | null;
}

export interface PublicJobDetail extends PublicJobListRow {
  body_ko: string | null;
  work_hours: string | null;
  contact_email: string | null;
  company_name_zh: string | null; // 기업명 비공개면 NULL
}

/** 필터 이름 → 컬럼. 이 고정 목록 밖의 이름은 SQL 에 들어가지 않는다. */
const FILTER_COLUMNS: Record<FilterKey, string> = {
  chinese_level: 'j.chinese_level',
  role_category: 'j.role_category',
  industry: 'j.industry',
  entry_stage: 'c.entry_stage',
  salary_basis: 'j.salary_basis',
  report_line: 'j.report_line',
  location: 'j.location',
};

/**
 * 공개 조건 (jobs j JOIN companies c). 값은 모두 바인딩한다.
 * 생산직 플래그는 값이 아니라 문장 모양으로 넣는다 — 꺼져 있으면 `j.job_family = 'office'` 가 되어
 * idx_jobs_status(status, job_family, published_at) 을 순서대로 읽을 수 있다. 두 모양 모두 고정 문자열이다.
 */
export function publicJobWhere(flags: Flags, now: number): { sql: string; binds: unknown[] } {
  return {
    sql: "j.status = 'published' AND c.verify_status = 'verified' AND j.agency_id IS NULL"
      + (flags.productionJobs ? " AND j.job_family IN ('office','production')" : " AND j.job_family = 'office'")
      + ' AND (j.closes_at IS NULL OR j.closes_at > ?)',
    binds: [now],
  };
}

/** 필터 조건. 값이 있는 필터만 `AND 컬럼 = ?` 로 붙인다. */
export function filterWhere(f: JobFilter): { sql: string; binds: unknown[] } {
  let sql = '';
  const binds: unknown[] = [];
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v === undefined) continue;
    sql += ` AND ${FILTER_COLUMNS[k]} = ?`;
    binds.push(v);
  }
  return { sql, binds };
}

const LIST_COLS =
  `j.id, j.title_ko,
   CASE WHEN j.company_name_public = 1 THEN c.id END AS company_id,
   CASE WHEN j.company_name_public = 1 THEN c.name_ko END AS company_name,
   c.entry_stage, j.location, j.role_category, j.industry, j.chinese_level, j.report_line,
   j.salary_min, j.salary_max, j.salary_basis, j.closes_at, j.published_at`;

/** 목록 SQL (EXPLAIN QUERY PLAN 확인용으로도 쓴다). 최신 게재 순, 같은 시각이면 id 역순. */
export function publicJobListSql(flags: Flags, now: number, f: JobFilter, limit: number, offset: number): { sql: string; binds: unknown[] } {
  const v = publicJobWhere(flags, now);
  const w = filterWhere(f);
  return {
    sql: `SELECT ${LIST_COLS} FROM jobs j JOIN companies c ON c.id = j.company_id
          WHERE ${v.sql}${w.sql}
          ORDER BY j.published_at DESC, j.id DESC LIMIT ? OFFSET ?`,
    binds: [...v.binds, ...w.binds, limit, offset],
  };
}

export async function listPublicJobs(
  db: Db, x: { flags: Flags; now: number; filter: JobFilter; limit: number; offset: number },
): Promise<PublicJobListRow[]> {
  const q = publicJobListSql(x.flags, x.now, x.filter, x.limit, x.offset);
  return (await db.prepare(q.sql).bind(...q.binds).all<PublicJobListRow>()).results;
}

/** 상세. 공개 조건을 만족하지 않으면 null (호출부는 보통의 404 를 낸다 — 있는지 없는지 알리지 않는다). */
export async function findPublicJob(db: Db, x: { id: string; flags: Flags; now: number }): Promise<PublicJobDetail | null> {
  const v = publicJobWhere(x.flags, x.now);
  return db.prepare(
    `SELECT ${LIST_COLS}, j.body_ko, j.work_hours, j.contact_email,
            CASE WHEN j.company_name_public = 1 THEN c.name_zh END AS company_name_zh
     FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = ? AND ${v.sql}`,
  ).bind(x.id, ...v.binds).first<PublicJobDetail>();
}
