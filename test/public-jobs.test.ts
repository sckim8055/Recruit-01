// 공개 공고 목록·상세 (T-06): 공개 조건, 필터, 페이지, 표시 문구, 캐시 키·머리글.
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { filterWhere, publicJobListSql, publicJobWhere, type PublicJobDetail, type PublicJobListRow } from '../src/db/public-jobs';
import {
  activeFilterCount, canonicalJobsHref, DEFAULT_PUBLIC_FILTERS, FILTER_KEYS, isJobId, isPubliclyVisible, jobsHref, MAX_PAGE, pageOf, pageQuery,
  parseEnabledFilters, parseJobFilter, parsePage, PUBLIC_PAGE_SIZE, readEnabledFiltersForm, serializeEnabledFilters,
  type FilterKey, type VisibilityInput,
} from '../src/lib/public-jobs';
import { pageCacheKey, PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from '../src/lib/page-cache';
import { closesText, publicSalaryText } from '../src/views/public-jobs';
import { parseKstDate } from '../src/lib/jobs';
import { buildOptionSet } from '../src/lib/options';
import { filterChoices } from '../src/lib/public-jobs';
import { optionRows } from './option-seed';

// T-06e: 직무·업계·근무지 값은 DB(job_options) 에서 온다. 기본 행(0007 = test/option-seed.ts)으로 만든 검색 값 목록.
const CHOICES = filterChoices(buildOptionSet(optionRows()));

const flagsOff = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
const flagsProd = { ...flagsOff, productionJobs: true };
const NOW = 1_800_000_000;
const ok: VisibilityInput = { status: 'published', agency_id: null, job_family: 'office', closes_at: null, company_verify_status: 'verified' };

describe('isPubliclyVisible', () => {
  const vis = (p: Partial<VisibilityInput>, flags = flagsOff) => isPubliclyVisible({ ...ok, ...p }, { flags, now: NOW });
  it('게재 중 + 검증 기업 + 사무직 + 마감 전이면 보인다', () => {
    expect(vis({})).toBe(true);
    expect(vis({ closes_at: NOW + 1 })).toBe(true);
  });
  it('초안·마감·차단은 보이지 않는다', () => {
    for (const status of ['draft', 'closed', 'blocked']) expect(vis({ status })).toBe(false);
  });
  it('미검증·반려 기업의 공고는 보이지 않는다', () => {
    expect(vis({ company_verify_status: 'pending' })).toBe(false);
    expect(vis({ company_verify_status: 'rejected' })).toBe(false);
  });
  it('헤드헌터 공고는 보이지 않는다 (플래그와 관계없이)', () => {
    expect(vis({ agency_id: 'a1' })).toBe(false);
    expect(vis({ agency_id: 'a1' }, { ...flagsOff, headhunterPosting: true })).toBe(false);
  });
  it('생산직은 FLAG_PRODUCTION_JOBS 가 켜졌을 때만', () => {
    expect(vis({ job_family: 'production' })).toBe(false);
    expect(vis({ job_family: 'production' }, flagsProd)).toBe(true);
  });
  it('마감일이 지났거나 지금이면 보이지 않는다', () => {
    expect(vis({ closes_at: NOW })).toBe(false);
    expect(vis({ closes_at: NOW - 1 })).toBe(false);
  });
});

describe('parseJobFilter', () => {
  it('목록 안의 값만 남기고 나머지는 버린다 (오류가 아니다)', () => {
    expect(parseJobFilter({
      chinese_level: 'business', role_category: 'sales', industry: 'nope', entry_stage: 'operating', salary_basis: '',
      report_line: 'cn_hq', location: "seoul' OR 1=1 --", page: '3', foo: 'bar',
    }, FILTER_KEYS, CHOICES)).toEqual({ chinese_level: 'business', role_category: 'sales', entry_stage: 'operating', report_line: 'cn_hq' });
  });
  it('빈 조건', () => expect(parseJobFilter({}, FILTER_KEYS, CHOICES)).toEqual({}));
  it('적용된 조건 개수', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ location: 'seoul', salary_basis: 'severance_included' })).toBe(2);
  });
});

describe('페이지', () => {
  it('parsePage: 잘못된 값은 1, 큰 값은 MAX_PAGE', () => {
    expect([undefined, '', 'abc', '0', '-2', '1.5', '1e3', '9999999'].map(parsePage)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(parsePage('2')).toBe(2);
    expect(parsePage(String(MAX_PAGE + 1))).toBe(MAX_PAGE);
    expect(parsePage('999999')).toBe(MAX_PAGE);
  });
  it('pageQuery: 한 행을 더 읽는다', () => {
    expect(pageQuery(1)).toEqual({ limit: PUBLIC_PAGE_SIZE + 1, offset: 0 });
    expect(pageQuery(3)).toEqual({ limit: 21, offset: 40 });
  });
  it('pageOf: 다음 페이지 여부', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(pageOf(rows(21), 1)).toMatchObject({ hasPrev: false, hasNext: true });
    expect(pageOf(rows(21), 1).rows).toHaveLength(20);
    expect(pageOf(rows(20), 2)).toMatchObject({ hasPrev: true, hasNext: false });
    expect(pageOf(rows(0), 7)).toMatchObject({ rows: [], hasPrev: true, hasNext: false });
    expect(pageOf(rows(21), MAX_PAGE).hasNext).toBe(false);
  });
  it('jobsHref: 필터는 정해진 순서, page 는 2 이상만', () => {
    expect(jobsHref({})).toBe('/jobs');
    expect(jobsHref({}, 1)).toBe('/jobs');
    expect(jobsHref({ location: 'seoul', chinese_level: 'native' }, 2)).toBe('/jobs?chinese_level=native&location=seoul&page=2');
  });
  it('isJobId: UUID 모양만', () => {
    expect(isJobId('0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f')).toBe(true);
    expect(isJobId('x')).toBe(false);
    expect(isJobId("0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f' OR 1")).toBe(false);
  });
});

describe('SQL 조각', () => {
  it('필터 값은 바인딩으로만 들어간다', () => {
    const w = filterWhere({ entry_stage: 'operating', location: 'seoul' });
    expect(w.sql).toBe(' AND c.entry_stage = ? AND j.location = ?');
    expect(w.binds).toEqual(['operating', 'seoul']);
    expect(filterWhere({}).sql).toBe('');
  });
  it('공개 조건의 모양 (생산직 플래그는 문장 모양, now 는 바인딩)', () => {
    expect(publicJobWhere(flagsOff, NOW).sql).toContain("j.job_family = 'office'");
    expect(publicJobWhere(flagsProd, NOW).sql).toContain("j.job_family IN ('office','production')");
    expect(publicJobWhere(flagsOff, NOW).binds).toEqual([NOW]);
  });
});

// SQLite 메모리 DB 에서 SQL 공개 조건과 isPubliclyVisible 이 같은 결과를 내는지 확인한다 (Node 22 의 node:sqlite).
describe('SQL 공개 조건 = isPubliclyVisible', async () => {
  type Db = { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void; all(...a: unknown[]): Record<string, unknown>[] } };
  let DatabaseSync: (new (p: string) => Db) | null = null;
  let fs: { readdirSync(p: string): string[]; readFileSync(p: string, e: 'utf8'): string } | null = null;
  try {
    const sqliteMod = 'node:sqlite', fsMod = 'node:fs';
    DatabaseSync = ((await import(sqliteMod)) as { DatabaseSync: new (p: string) => Db }).DatabaseSync;
    fs = (await import(fsMod)) as typeof fs;
  } catch { /* node:sqlite 가 없는 Node 버전 */ }

  it.skipIf(!DatabaseSync)('모든 경우에서 같다 (생산직 플래그 켬·끔, 필터 포함)', () => {
    const db = new DatabaseSync!(':memory:');
    for (const f of fs!.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs!.readFileSync(`migrations/${f}`, 'utf8'));
    db.exec("INSERT INTO users (id, email, role, created_at) VALUES ('u1','u1@example.test','company',0)");
    db.exec("INSERT INTO agencies (id, name, created_at) VALUES ('a1','가짜 헤드헌터',0)");
    const cases: (VisibilityInput & { id: string; entry_stage: string })[] = [];
    let n = 0;
    for (const company_verify_status of ['verified', 'pending', 'rejected'])
      for (const status of ['draft', 'published', 'closed', 'blocked'])
        for (const agency_id of [null, 'a1'])
          for (const job_family of ['office', 'production'])
            for (const closes_at of [null, NOW - 1, NOW, NOW + 86400]) {
              const id = `j${String(n++).padStart(4, '0')}`;
              cases.push({ id, company_verify_status, status, agency_id, job_family, closes_at, entry_stage: n % 2 ? 'operating' : 'preparing' });
            }
    const insC = db.prepare("INSERT INTO companies (id, name_ko, entity_type, entry_stage, verify_status, created_at) VALUES (?,?,'kr_entity',?,?,0)");
    const insJ = db.prepare(
      `INSERT INTO jobs (id, company_id, agency_id, created_by, job_family, title_ko, status, published_at, closes_at, created_at, updated_at, location)
       VALUES (?,?,?,'u1',?,'t',?,?,?,0,0,'seoul')`,
    );
    for (const c of cases) {
      insC.run(`c_${c.id}`, '가짜기업', c.entry_stage, c.company_verify_status);
      insJ.run(c.id, `c_${c.id}`, c.agency_id, c.job_family, c.status, 1000 + Number(c.id.slice(1)), c.closes_at);
    }
    for (const flags of [flagsOff, flagsProd]) {
      for (const filter of [{}, { entry_stage: 'operating' }]) {
        const q = publicJobListSql(flags, NOW, filter, 10_000, 0);
        const got = db.prepare(q.sql).all(...q.binds).map((r) => r.id);
        const want = cases
          .filter((c) => isPubliclyVisible(c, { flags, now: NOW }) && (!('entry_stage' in filter) || c.entry_stage === 'operating'))
          .map((c) => c.id).sort().reverse(); // published_at 은 id 순서와 같게 넣었다 → 최신 순 = id 역순
        expect(got).toEqual(want);
        expect(got.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('표시 문구', () => {
  it('연봉: 범위·단위·퇴직금 기준, 없으면 협의', () => {
    expect(publicSalaryText('ko', { salary_min: 5000, salary_max: 7000, salary_basis: 'severance_excluded' }))
      .toBe('5,000 ~ 7,000 만원/년 (퇴직금 별도)');
    expect(publicSalaryText('ko', { salary_min: 4500, salary_max: null, salary_basis: 'severance_included' })).toBe('4,500 만원/년 (퇴직금 포함)');
    expect(publicSalaryText('ko', { salary_min: null, salary_max: null, salary_basis: null })).toBe('협의');
    expect(publicSalaryText('zh', { salary_min: null, salary_max: null, salary_basis: null })).toBe('面议');
  });
  it('마감일: 날짜 또는 상시', () => {
    expect(closesText('ko', parseKstDate('2026-12-31'))).toBe('2026-12-31');
    expect(closesText('ko', null)).toBe('상시');
    expect(closesText('zh', null)).toBe('长期有效');
  });
});

describe('pageCacheKey', () => {
  it('언어가 키에 들어간다', () => {
    expect(pageCacheKey('https://x.test/jobs', 'ko')).toBe('https://x.test/jobs?__locale=ko');
    expect(pageCacheKey('https://x.test/jobs', 'zh')).not.toBe(pageCacheKey('https://x.test/jobs', 'ko'));
  });
  it('검색 조건 순서가 달라도 같은 키, 값이 다르면 다른 키', () => {
    const a = pageCacheKey('https://x.test/jobs?location=seoul&chinese_level=basic', 'ko');
    expect(a).toBe(pageCacheKey('https://x.test/jobs?chinese_level=basic&location=seoul', 'ko'));
    expect(a).not.toBe(pageCacheKey('https://x.test/jobs?chinese_level=basic&location=busan', 'ko'));
    expect(pageCacheKey('https://x.test/jobs?page=2', 'ko')).not.toBe(pageCacheKey('https://x.test/jobs?page=3', 'ko'));
  });
  it('주소의 __locale 은 판별된 언어로 덮어쓴다', () => {
    expect(pageCacheKey('https://x.test/jobs?__locale=zh', 'ko')).toBe('https://x.test/jobs?__locale=ko');
  });
  it('경로가 다르면 다른 키', () => {
    expect(pageCacheKey('https://x.test/', 'ko')).toBe('https://x.test/?__locale=ko');
    expect(pageCacheKey('https://x.test/jobs/a', 'ko')).not.toBe(pageCacheKey('https://x.test/jobs/b', 'ko'));
  });
});

// ── 라우트 (가짜 D1). 이 실행 환경에는 caches.default 가 없어 캐시 저장 없이 머리글만 확인한다.

const listRow: PublicJobListRow = {
  id: '0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f', title_ko: '<script>alert(1)</script>영업', company_id: 'c1', company_name: '가짜기업<b>',
  entry_stage: 'operating', location: 'seoul', role_category: 'sales', industry: 'trade', chinese_level: 'business', report_line: 'cn_hq',
  salary_min: 5000, salary_max: 6000, salary_basis: 'severance_excluded', closes_at: null, published_at: NOW,
};
const detailRow: PublicJobDetail = {
  ...listRow, body_ko: '<img src=x onerror=alert(1)>\n둘째 줄', work_hours: '09:00-18:00', contact_email: 'hr@example-corp.test', company_name_zh: null,
};

function fakeDb(o: { rows?: PublicJobListRow[]; detail?: PublicJobDetail | null; session?: unknown; setting?: string | null }) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        first: async () => (sql.includes('FROM sessions') ? o.session ?? null
          : sql.includes('FROM site_settings') ? (o.setting == null ? null : { value: o.setting })
          : o.detail ?? null),
        all: async () => ({ results: sql.includes('FROM job_options') ? optionRows() : o.rows ?? [] }),
      };
      return stmt;
    },
  };
}
const env = (db: unknown) => ({ APP_ENV: 'dev', DB: db, SESSION_PEPPER: 'test', REGISTRATION_NO: '', FLAG_PRODUCTION_JOBS: 'off' }) as never;
const get = (path: string, db: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers }) as never, env(db));

describe('공개 화면 응답', () => {
  it('비로그인 /jobs: public 캐시 머리글 + Vary, 목록·필터 개수', async () => {
    const res = await get('/jobs?location=seoul', fakeDb({ rows: [listRow] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get('vary')).toBe('Cookie, Accept-Language');
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expect(html).toContain('적용된 조건 1개');
    expect(html).toContain('5,000 ~ 6,000 만원/년 (퇴직금 별도)');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;영업');
  });
  it('로그인 쿠키가 있으면 private, no-store', async () => {
    const session = { id: 'u1', email: 's@example.test', role: 'seeker', locale: 'ko', mfa: 0 };
    const res = await get('/jobs', fakeDb({ rows: [], session }), { cookie: 'sid=abc' });
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    const html = await res.text();
    expect(html).toContain('/logout');
  });
  it('상세: 본문은 글로 출력, 연락처 mailto, 비로그인에게도 같은 지원 링크 (T-08)', async () => {
    const res = await get(`/jobs/${listRow.id}`, fakeDb({ detail: detailRow }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="mailto:hr@example-corp.test"');
    expect(html).toContain(`href="/jobs/${listRow.id}/apply"`);
    expect(html).toContain('href="/companies/c1"');
  });
  it('기업명 비공개: 이름·링크 없음', async () => {
    const res = await get(`/jobs/${listRow.id}`, fakeDb({ detail: { ...detailRow, company_id: null, company_name: null } }));
    const html = await res.text();
    expect(html).toContain('기업명 비공개');
    expect(html).not.toContain('/companies/');
    expect(html).not.toContain('가짜기업');
  });
  it('보이지 않는 공고·잘못된 id 는 보통의 404, 캐시하지 않음', async () => {
    const a = await get(`/jobs/${listRow.id}`, fakeDb({ detail: null }));
    expect(a.status).toBe(404);
    expect(a.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    const b = await get('/jobs/not-a-uuid', fakeDb({}));
    expect(b.status).toBe(404);
    expect(await b.text()).toContain('페이지를 찾을 수 없습니다');
  });
  it('중국어 화면: 문구는 중국어, 공고 제목은 한국어 그대로', async () => {
    const res = await get('/jobs', fakeDb({ rows: [listRow] }), { cookie: 'lang=zh' });
    // lang 쿠키만 있는 요청은 비로그인 → 캐시 대상
    expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE_CONTROL);
    const html = await res.text();
    expect(html).toContain('招聘职位');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;영업');
  });
  it('홈: 최신 공고', async () => {
    const res = await get('/', fakeDb({ rows: [listRow] }));
    expect(res.headers.get('cache-control')).toBe(PUBLIC_CACHE_CONTROL);
    expect(await res.text()).toContain(`/jobs/${listRow.id}`);
  });
});

describe('정규화 주소', async () => {
  const { canonicalJobsHref, canonicalJobHref } = await import('../src/lib/public-jobs');
  const { pathAndSearch } = await import('../src/render');
  it('폼이 보낸 빈 칸·모르는 이름·page=1 을 지우고 순서를 맞춘다', () => {
    expect(canonicalJobsHref({ chinese_level: '', location: 'seoul', report_line: 'cn_hq', page: '1', x: 'y' }, FILTER_KEYS, CHOICES))
      .toBe('/jobs?report_line=cn_hq&location=seoul');
    expect(canonicalJobsHref({ page: '0' }, FILTER_KEYS, CHOICES)).toBe('/jobs');
    expect(canonicalJobsHref({ page: '500' }, FILTER_KEYS, CHOICES)).toBe(`/jobs?page=${MAX_PAGE}`);
    expect(canonicalJobsHref({ location: 'seoul', lang: 'zh' }, FILTER_KEYS, CHOICES)).toBe('/jobs?location=seoul&lang=zh');
    expect(canonicalJobsHref({ lang: 'fr' }, FILTER_KEYS, CHOICES)).toBe('/jobs');
  });
  it('상세는 lang 만 남긴다', () => {
    expect(canonicalJobHref('abc', { t: '1' })).toBe('/jobs/abc');
    expect(canonicalJobHref('abc', { lang: 'ko' })).toBe('/jobs/abc?lang=ko');
  });
  it('언어 전환 후 돌아올 주소는 ?lang= 을 뺀다', () => {
    expect(pathAndSearch('http://x.test/jobs?location=seoul&lang=zh')).toBe('/jobs?location=seoul');
    expect(pathAndSearch('http://x.test/jobs?lang=zh')).toBe('/jobs');
  });
  it('정규화되지 않은 /jobs 주소는 302 (설정 한 행 + 선택 항목 목록만 읽고 공고는 읽지 않는다)', async () => {
    const read: string[] = [];
    const db = {
      prepare(sql: string) {
        read.push(sql);
        if (!sql.includes('FROM site_settings') && !sql.includes('FROM job_options')) throw new Error('공고를 읽으면 안 된다');
        const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: optionRows() }) };
        return stmt;
      },
    };
    const res = await get('/jobs?chinese_level=&location=seoul', db);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/jobs?location=seoul');
    expect(read).toHaveLength(2);
  });
});

// ── 보일 필터 설정 (T-06d)

describe('parseEnabledFilters', () => {
  it('설정이 없으면 기본값 세 개 (중국어 수준·보고 라인·근무지)', () => {
    expect(parseEnabledFilters(null)).toEqual(['chinese_level', 'report_line', 'location']);
    expect([...DEFAULT_PUBLIC_FILTERS]).toEqual(['chinese_level', 'report_line', 'location']);
  });
  it('JSON 아님·배열 아님·문자열 아닌 원소 → 기본값', () => {
    for (const raw of ['', 'not json', '{"a":1}', '"location"', 'null', '1', '[1,2]', '["location",null]']) {
      expect(parseEnabledFilters(raw), raw).toEqual(['chinese_level', 'report_line', 'location']);
    }
  });
  it('모르는 이름·중복은 버린다', () => {
    expect(parseEnabledFilters('["industry","nope","industry","__proto__"]')).toEqual(['industry']);
    expect(parseEnabledFilters('["nope"]')).toEqual([]);
  });
  it('빈 배열은 "검색 칸 없음" 으로 그대로 쓴다', () => expect(parseEnabledFilters('[]')).toEqual([]));
  it('순서는 저장 순서가 아니라 FILTER_KEYS 순서', () => {
    expect(parseEnabledFilters('["location","industry","chinese_level"]')).toEqual(['chinese_level', 'industry', 'location']);
    expect(parseEnabledFilters(JSON.stringify([...FILTER_KEYS].reverse()))).toEqual(FILTER_KEYS);
  });
});

describe('관리자 설정 폼 값 (readEnabledFiltersForm)', () => {
  it('체크한 것만, 모르는 값은 버리고, FILTER_KEYS 순서로', () => {
    expect(readEnabledFiltersForm(['location', 'x', 'industry', 'location'])).toEqual(['industry', 'location']);
    expect(readEnabledFiltersForm('salary_basis')).toEqual(['salary_basis']);
    expect(readEnabledFiltersForm('nope')).toEqual([]);
  });
  it('아무것도 체크하지 않으면(값 없음) 빈 목록', () => {
    expect(readEnabledFiltersForm(undefined)).toEqual([]);
    expect(readEnabledFiltersForm([])).toEqual([]);
  });
  it('파일 등 문자열이 아닌 값은 버린다', () => {
    expect(readEnabledFiltersForm([{ name: 'x' }, 'report_line'])).toEqual(['report_line']);
  });
  it('저장값은 다시 읽으면 같은 목록 (빈 목록 포함)', () => {
    for (const keys of [[], ['location'], FILTER_KEYS] as FilterKey[][]) {
      expect(parseEnabledFilters(serializeEnabledFilters(keys))).toEqual(keys);
    }
    expect(serializeEnabledFilters(['location', 'chinese_level'])).toBe('["chinese_level","location"]');
  });
});

describe('숨긴 필터는 모르는 조건과 같다', () => {
  const enabled: FilterKey[] = ['chinese_level', 'location'];
  it('parseJobFilter: 숨긴 필터는 걸러지지 않고 개수에도 들지 않는다', () => {
    const f = parseJobFilter({ chinese_level: 'business', industry: 'trade', location: 'seoul', report_line: 'cn_hq' }, enabled, CHOICES);
    expect(f).toEqual({ chinese_level: 'business', location: 'seoul' });
    expect(activeFilterCount(f)).toBe(2);
    expect(parseJobFilter({ industry: 'trade' }, [], CHOICES)).toEqual({});
  });
  it('canonicalJobsHref: 숨긴 필터를 지운다', () => {
    expect(canonicalJobsHref({ industry: 'trade', location: 'seoul', page: '2', lang: 'zh' }, enabled, CHOICES)).toBe('/jobs?location=seoul&page=2&lang=zh');
    expect(canonicalJobsHref({ industry: 'trade' }, [], CHOICES)).toBe('/jobs');
    expect(canonicalJobsHref({ industry: 'trade' }, ['industry'], CHOICES)).toBe('/jobs?industry=trade');
  });
});

describe('/jobs 와 보일 필터 설정', () => {
  const selects = (html: string) => [...html.matchAll(/<select name="([a-z_]+)"/g)].map((m) => m[1]);
  it('설정이 없으면 기본 세 개만 (FILTER_KEYS 순서)', async () => {
    const res = await get('/jobs', fakeDb({ rows: [listRow] }));
    expect(selects(await res.text())).toEqual(['chinese_level', 'report_line', 'location']);
  });
  it('저장된 설정의 필터만, 저장 순서와 관계없이 FILTER_KEYS 순서', async () => {
    const res = await get('/jobs', fakeDb({ rows: [listRow], setting: '["location","industry"]' }));
    expect(selects(await res.text())).toEqual(['industry', 'location']);
  });
  it('빈 설정이면 검색 칸(폼·검색 버튼·적용 개수) 자체가 없고, 목록 줄은 그대로', async () => {
    const res = await get('/jobs', fakeDb({ rows: [listRow], setting: '[]' }));
    const html = await res.text();
    expect(html).not.toContain('action="/jobs"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('>검색<');
    expect(html).not.toContain('적용된 조건');
    expect(html).toContain(`/jobs/${listRow.id}`);
    expect(html).toContain('class="facts-line"');
  });
  it('숨긴 필터가 붙은 주소는 그 조건을 지운 주소로 302', async () => {
    const res = await get('/jobs?industry=trade&location=seoul', fakeDb({ setting: '["location"]' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/jobs?location=seoul');
    const res2 = await get('/jobs?industry=trade', fakeDb({ setting: '[]' }));
    expect(res2.headers.get('location')).toBe('/jobs');
  });
  it('보이는 필터는 SQL 에 들어가고, 숨긴 필터는 들어가지 않는다', async () => {
    const seen: { sql: string; binds: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind: (...b: unknown[]) => { seen.push({ sql, binds: b }); return stmt; },
          first: async () => (sql.includes('FROM site_settings') ? { value: '["industry"]' } : null),
          all: async () => ({ results: sql.includes('FROM job_options') ? optionRows() : [listRow] }),
        };
        return stmt;
      },
    };
    const res = await get('/jobs?industry=trade', db);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('적용된 조건 1개');
    const list = seen.find((x) => x.sql.includes('FROM jobs'))!;
    expect(list.sql).toContain('j.industry = ?');
    expect(list.binds).toContain('trade');
  });
  it('상세는 설정과 관계없이 모든 항목을 보인다', async () => {
    const res = await get(`/jobs/${listRow.id}`, fakeDb({ detail: detailRow, setting: '[]' }));
    const html = await res.text();
    for (const label of ['직무', '업계', '근무지', '보고 라인', '중국어 수준']) expect(html).toContain(label);
  });
});

describe('/admin/settings 권한', () => {
  it('비로그인은 로그인 화면으로, 구직자·기업 담당자는 403', async () => {
    const anon = await get('/admin/settings', fakeDb({}));
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/login');
    for (const role of ['seeker', 'company']) {
      const session = { id: 'u1', email: 'x@example.test', role, locale: 'ko', mfa: 0 };
      const res = await get('/admin/settings', fakeDb({ session }), { cookie: 'sid=abc' });
      expect(res.status, role).toBe(403);
    }
  });
});

describe('/admin/settings (관리자)', () => {
  const admin = { id: 'adm1', email: 'a@example.test', role: 'admin', locale: 'ko', mfa: 1 };
  function adminDb(setting: string | null) {
    const writes: unknown[][] = [];
    return {
      writes,
      prepare(sql: string) {
        let b: unknown[] = [];
        const stmt = {
          bind: (...x: unknown[]) => { b = x; return stmt; },
          first: async () => (sql.includes('FROM sessions') ? admin : sql.includes('FROM site_settings') ? (setting == null ? null : { value: setting }) : null),
          all: async () => ({ results: [] }),
          run: async () => { if (sql.includes('INSERT INTO site_settings')) writes.push(b); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
  }
  it('GET: 필터마다 체크박스, 현재 설정이 체크됨 (설정 없음 = 기본값), 안내 문구', async () => {
    const res = await get('/admin/settings', adminDb(null), { cookie: 'sid=abc' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const boxes = [...html.matchAll(/<input type="checkbox" name="filters" value="([a-z_]+)"( checked="")?/g)].map((m) => [m[1], !!m[2]]);
    expect(boxes.map((b) => b[0])).toEqual(FILTER_KEYS);
    expect(boxes.filter((b) => b[1]).map((b) => b[0])).toEqual(['chinese_level', 'report_line', 'location']);
    expect(html).toContain('숨긴 조건도 공고 내용에는 그대로 표시됩니다');
    expect(html).toContain('60초');
  });
  it('POST: 모르는 값은 버리고 FILTER_KEYS 순서 JSON 으로 저장, 누가·언제 함께', async () => {
    const db = adminDb(null);
    const body = new URLSearchParams([['filters', 'location'], ['filters', 'bogus'], ['filters', 'industry']]);
    const res = await app.fetch(new Request('http://localhost/admin/settings', {
      method: 'POST', body, headers: { cookie: 'sid=abc', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, env(db));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?ok=saved');
    expect(db.writes).toHaveLength(1);
    const [key, value, by, at] = db.writes[0]!;
    expect([key, value, by]).toEqual(['public_job_filters', '["industry","location"]', 'adm1']);
    expect(typeof at).toBe('number');
  });
  it('POST: 모두 끄면 빈 배열을 저장', async () => {
    const db = adminDb('["location"]');
    const res = await app.fetch(new Request('http://localhost/admin/settings', {
      method: 'POST', body: new URLSearchParams(), headers: { cookie: 'sid=abc', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    }) as never, env(db));
    expect(res.status).toBe(302);
    expect(db.writes[0]![1]).toBe('[]');
  });
});
