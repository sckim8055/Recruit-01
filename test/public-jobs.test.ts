// 공개 공고 목록·상세 (T-06): 공개 조건, 필터, 페이지, 표시 문구, 캐시 키·머리글.
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { filterWhere, publicJobListSql, publicJobWhere, type PublicJobDetail, type PublicJobListRow } from '../src/db/public-jobs';
import {
  activeFilterCount, isJobId, isPubliclyVisible, jobsHref, MAX_PAGE, pageOf, pageQuery, parseJobFilter, parsePage, PUBLIC_PAGE_SIZE,
  type VisibilityInput,
} from '../src/lib/public-jobs';
import { pageCacheKey, PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from '../src/lib/page-cache';
import { closesText, publicSalaryText } from '../src/views/public-jobs';
import { parseKstDate } from '../src/lib/jobs';

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
    })).toEqual({ chinese_level: 'business', role_category: 'sales', entry_stage: 'operating', report_line: 'cn_hq' });
  });
  it('빈 조건', () => expect(parseJobFilter({})).toEqual({}));
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

function fakeDb(o: { rows?: PublicJobListRow[]; detail?: PublicJobDetail | null; session?: unknown }) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        first: async () => (sql.includes('FROM sessions') ? o.session ?? null : o.detail ?? null),
        all: async () => ({ results: o.rows ?? [] }),
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
  it('상세: 본문은 글로 출력, 연락처 mailto, 지원 버튼 없음', async () => {
    const res = await get(`/jobs/${listRow.id}`, fakeDb({ detail: detailRow }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('href="mailto:hr@example-corp.test"');
    expect(html).not.toMatch(/\/apply/);
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
    expect(canonicalJobsHref({ chinese_level: '', location: 'seoul', report_line: 'cn_hq', page: '1', x: 'y' }))
      .toBe('/jobs?report_line=cn_hq&location=seoul');
    expect(canonicalJobsHref({ page: '0' })).toBe('/jobs');
    expect(canonicalJobsHref({ page: '500' })).toBe(`/jobs?page=${MAX_PAGE}`);
    expect(canonicalJobsHref({ location: 'seoul', lang: 'zh' })).toBe('/jobs?location=seoul&lang=zh');
    expect(canonicalJobsHref({ lang: 'fr' })).toBe('/jobs');
  });
  it('상세는 lang 만 남긴다', () => {
    expect(canonicalJobHref('abc', { t: '1' })).toBe('/jobs/abc');
    expect(canonicalJobHref('abc', { lang: 'ko' })).toBe('/jobs/abc?lang=ko');
  });
  it('언어 전환 후 돌아올 주소는 ?lang= 을 뺀다', () => {
    expect(pathAndSearch('http://x.test/jobs?location=seoul&lang=zh')).toBe('/jobs?location=seoul');
    expect(pathAndSearch('http://x.test/jobs?lang=zh')).toBe('/jobs');
  });
  it('정규화되지 않은 /jobs 주소는 302 (DB 를 읽지 않는다)', async () => {
    const res = await get('/jobs?chinese_level=&location=seoul', { prepare() { throw new Error('DB 를 읽으면 안 된다'); } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/jobs?location=seoul');
  });
});
