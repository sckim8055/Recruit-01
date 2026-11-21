// 공개 공고 목록·상세(/jobs)의 판단. 순수 함수만 둔다 (DB·네트워크 접근 없음) — test/public-jobs.test.ts 로 검증한다.
//
// 공개 조건(isPubliclyVisible)은 src/db/public-jobs.ts 의 publicJobWhere() 와 같은 뜻이어야 한다.
// 둘이 어긋나지 않는지 test/public-jobs.test.ts 가 SQLite 메모리 DB 에서 같은 경우들을 비교한다.
// 게재(published 로 바꾸기) 판단은 여기서 하지 않는다 — rules.publishBlocks 만 한다 (CLAUDE.md 규칙 2).
// 여기는 "이미 게재된 공고 중 지금 구직자에게 보여도 되는가" 만 정한다.
import type { Flags } from '../env';
import { ENTRY_STAGES } from './company';
import { CHINESE_LEVELS, INDUSTRIES, LOCATIONS, REPORT_LINES, ROLE_CATEGORIES, SALARY_BASES } from './jobs';

export const PUBLIC_PAGE_SIZE = 20;
export const HOME_JOB_COUNT = 5;
/** 이보다 뒤 페이지는 이 페이지로 줄인다 (OFFSET 이 커지면 D1 이 건너뛴 행도 읽기 때문). 20 × 100 = 2,000건. */
export const MAX_PAGE = 100;

// ── 공개 조건

export interface VisibilityInput {
  status: string;
  agency_id: string | null;
  job_family: string;
  closes_at: number | null;
  company_verify_status: string;
}

/**
 * 구직자에게 보여도 되는 공고인가. 모두 만족해야 한다:
 * - 게재 중(published). 초안·마감·차단은 보이지 않는다
 * - 기업이 검증 완료(verified). 승인 취소된 기업의 공고는 T-04b 에서 closed 가 되지만, 여기서도 한 번 더 막는다
 * - 헤드헌터 공고(agency_id 있음)가 아님 — FLAG_HEADHUNTER_POSTING 이 꺼져 있는 동안은 플래그와 관계없이 막는다 (T-15 에서 다시 정한다)
 * - 사무직(office), 또는 FLAG_PRODUCTION_JOBS 가 켜져 있음
 * - 마감일이 없거나 아직 지나지 않음 (closes_at 은 마감일 23:59:59 한국 시간)
 */
export function isPubliclyVisible(j: VisibilityInput, ctx: { flags: Flags; now: number }): boolean {
  return j.status === 'published'
    && j.company_verify_status === 'verified'
    && j.agency_id == null
    && (j.job_family === 'office' || ctx.flags.productionJobs)
    && (j.closes_at == null || j.closes_at > ctx.now);
}

// ── 필터

/** 필터 이름 → 고를 수 있는 값. 공고 작성 폼·기업 정보 폼의 목록을 그대로 쓴다 (새 목록을 만들지 않는다). */
export const FILTER_CHOICES = {
  chinese_level: CHINESE_LEVELS,
  role_category: ROLE_CATEGORIES,
  industry: INDUSTRIES,
  entry_stage: ENTRY_STAGES,
  salary_basis: SALARY_BASES,
  report_line: REPORT_LINES,
  location: LOCATIONS,
} as const;

export type FilterKey = keyof typeof FILTER_CHOICES;
export const FILTER_KEYS = Object.keys(FILTER_CHOICES) as FilterKey[];
export type JobFilter = Partial<Record<FilterKey, string>>;

/**
 * 주소의 검색 조건을 정규화한다. 모르는 이름·값, 빈 값, 같은 이름이 여러 번 온 경우의 뒤쪽 값은 버린다 (오류로 보지 않는다).
 * 결과에는 목록에 있는 값만 들어간다 — DB 계층은 이 값을 바인딩 매개변수로만 쓴다.
 */
export function parseJobFilter(q: Record<string, string | undefined>): JobFilter {
  const out: JobFilter = {};
  for (const k of FILTER_KEYS) {
    const v = q[k];
    if (typeof v === 'string' && (FILTER_CHOICES[k] as readonly string[]).includes(v)) out[k] = v;
  }
  return out;
}

export const activeFilterCount = (f: JobFilter): number => FILTER_KEYS.filter((k) => f[k] !== undefined).length;

// ── 페이지

/** ?page= 값. 숫자가 아니거나 1보다 작으면 1, MAX_PAGE 보다 크면 MAX_PAGE. */
export function parsePage(raw: string | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1;
  const n = Number(raw);
  return n < 1 ? 1 : n > MAX_PAGE ? MAX_PAGE : n;
}

/**
 * 한 페이지를 읽을 때 쓰는 값. 전체 개수(COUNT)를 세지 않고 한 행을 더 읽어(limit = size + 1) 다음 페이지가 있는지만 안다.
 */
export function pageQuery(page: number, size = PUBLIC_PAGE_SIZE): { limit: number; offset: number } {
  return { limit: size + 1, offset: (page - 1) * size };
}

/** 읽은 행(최대 size + 1개)을 화면에 보일 행과 이전·다음 페이지 여부로 나눈다. */
export function pageOf<T>(rows: T[], page: number, size = PUBLIC_PAGE_SIZE): { rows: T[]; page: number; hasPrev: boolean; hasNext: boolean } {
  return { rows: rows.slice(0, size), page, hasPrev: page > 1, hasNext: rows.length > size && page < MAX_PAGE };
}

/** 목록 주소. 필터는 FILTER_KEYS 순서로, page 는 2 이상일 때만 붙인다 (같은 조건이면 같은 주소 → 캐시가 잘 맞는다). */
export function jobsHref(f: JobFilter, page = 1): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) { const v = f[k]; if (v !== undefined) p.set(k, v); }
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `/jobs?${s}` : '/jobs';
}

/** /jobs/:id 의 id. 공고 id 는 crypto.randomUUID() 이다. 모양이 다르면 DB 를 읽지 않고 404. */
export const isJobId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

/** ?lang= (lib/i18n.detectLocale 이 읽는다). 정규화 주소로 보낼 때도 남긴다. */
const langOf = (q: Record<string, string | undefined>): string | undefined => (q.lang === 'ko' || q.lang === 'zh' ? q.lang : undefined);
const withLang = (href: string, lang: string | undefined): string => (lang ? `${href}${href.includes('?') ? '&' : '?'}lang=${lang}` : href);

/**
 * /jobs 의 정규화 주소. 필터 폼(GET)은 고르지 않은 칸도 빈 값으로 보내므로(`?chinese_level=&location=seoul…`),
 * 같은 조건이 여러 주소가 되어 캐시가 나뉜다. 요청 주소가 이것과 다르면 이 주소로 보낸다 (모르는 이름·값, page=1 도 지운다).
 */
export const canonicalJobsHref = (q: Record<string, string | undefined>): string =>
  withLang(jobsHref(parseJobFilter(q), parsePage(q.page)), langOf(q));

/** /jobs/:id 의 정규화 주소: 검색 조건은 lang 만 남긴다. */
export const canonicalJobHref = (id: string, q: Record<string, string | undefined>): string => withLang(`/jobs/${id}`, langOf(q));
