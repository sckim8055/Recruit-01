// 공개 공고 목록·상세 (/jobs, /jobs/:id) 와 홈(/). 누구나 볼 수 있다.
// 공개 조건은 db/public-jobs.publicJobWhere (= lib/public-jobs.isPubliclyVisible) 하나다. 보이지 않는 공고는 보통의 404 — 있는지 알리지 않는다.
// 로그인하지 않은 요청은 lib/page-cache 의 캐시를 거친다 (60초).
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { flagsOf, now, type AppEnv } from '../env';
import { findPublicJob, listPublicJobs } from '../db/public-jobs';
import { listOptions } from '../db/options';
import { getSetting } from '../db/settings';
import { buildOptionSet } from '../lib/options';
import {
  activeFilterCount, canonicalJobHref, canonicalJobsHref, filterChoices, HOME_JOB_COUNT, isJobId, pageOf, pageQuery, parseEnabledFilters, parseJobFilter, parsePage,
  PUBLIC_FILTERS_SETTING,
} from '../lib/public-jobs';
import { pageCache, PAGE_VARY, PRIVATE_CACHE_CONTROL } from '../lib/page-cache';
import { render, renderError } from '../render';
import { Home } from '../views/pages';
import { PublicJobList, PublicJobPage, type ApplyState } from '../views/public-jobs';
import { hasApplied } from '../db/applications';

export const jobs = new Hono<AppEnv>();

/**
 * 홈의 캐시 (index.tsx 에서 '/' 에 붙인다). 탈퇴 직후의 `?bye=1` 요청은 page-cache 를 거치지 않고 no-store 로 그린다 —
 * 안내 문구가 든 화면이 공유 캐시에 들어가지 않게. 안내 문구는 이 경로에서만 그려지므로(homePage 가 bye=1 일 때만 그림)
 * 캐시되는 홈(`/`, 그 밖의 검색 조건)에는 들어가지 않는다.
 */
export const homeCache: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.query('bye') !== '1') return pageCache(c, next);
  await next();
  c.res.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  c.res.headers.set('Vary', PAGE_VARY);
  c.res.headers.set('X-Page-Cache', 'bypass');
};

/** 홈 (index.tsx 에서 '/' 에 붙인다). */
// 직무·업계·근무지 이름(job_options, T-06e)은 캐시에 없는 요청마다 listOptions 한 번으로 읽는다 (약 50행). 따로 캐시하지 않는다 (메모리 전역 없음).
export async function homePage(c: Context<AppEnv>) {
  const [rows, optionRows] = await Promise.all([
    listPublicJobs(c.env.DB, { flags: flagsOf(c.env), now: now(), filter: {}, limit: HOME_JOB_COUNT, offset: 0 }),
    listOptions(c.env.DB),
  ]);
  return render(c, <Home locale={c.var.locale} jobs={rows} options={buildOptionSet(optionRows)} bye={c.req.query('bye') === '1'} />);
}

/** 요청 주소(경로 + 검색 조건)가 정규화 주소와 다른가. */
const differs = (c: Context<AppEnv>, href: string): boolean => {
  const u = new URL(c.req.url);
  return u.pathname + u.search !== href;
};

jobs.get('/', pageCache, async (c) => {
  // 보일 필터(관리자 설정, T-06d)와 직무·업계·근무지 항목(T-06e). 캐시에 없는 요청마다 이 두 작은 읽기만 한 뒤 정규화를 판단한다
  // (설정 기본 키 한 행 + job_options 전체 약 50행, 동시에). 캐시 hit 이면 여기까지 오지 않는다.
  // 따로 캐시하지 않는다 — 바꾸면 비로그인 화면에는 page-cache TTL(60초) 안에 반영된다.
  const [setting, optionRows] = await Promise.all([getSetting(c.env.DB, PUBLIC_FILTERS_SETTING), listOptions(c.env.DB)]);
  const enabled = parseEnabledFilters(setting);
  const options = buildOptionSet(optionRows);
  const choices = filterChoices(options);
  // 빈 칸·모르는 조건·숨긴 조건·사용 종료된 항목·page=1 이 붙은 주소는 정규화 주소로 보낸다 (공고는 읽지 않는다. 302 는 캐시하지 않는다).
  const canonical = canonicalJobsHref(c.req.query(), enabled, choices);
  if (differs(c, canonical)) return c.redirect(canonical, 302);
  const filter = parseJobFilter(c.req.query(), enabled, choices);
  const page = parsePage(c.req.query('page'));
  const { limit, offset } = pageQuery(page);
  const rows = await listPublicJobs(c.env.DB, { flags: flagsOf(c.env), now: now(), filter, limit, offset });
  const pg = pageOf(rows, page);
  // 조건 알림 만들기 칸 (T-10): 로그인한 구직자에게만, 조건을 하나 이상 골랐을 때만. 로그인한 요청은 page-cache 를 거치지 않으므로(private, no-store)
  // 비로그인 캐시 화면은 바뀌지 않는다 (누구에게나 같은 HTML). 추가로 읽는 것은 없다.
  const alertForm = c.var.user?.role === 'seeker' && activeFilterCount(filter) > 0;
  return render(c, <PublicJobList locale={c.var.locale} filter={filter} enabled={enabled} choices={choices} options={options} alertForm={alertForm} {...pg} />, 'pj.title');
});

jobs.get('/:id', pageCache, async (c) => {
  const id = c.req.param('id');
  if (!isJobId(id)) return renderError(c, 404);
  const canonical = canonicalJobHref(id, c.req.query());
  if (differs(c, canonical)) return c.redirect(canonical, 302);
  const [job, optionRows] = await Promise.all([findPublicJob(c.env.DB, { id, flags: flagsOf(c.env), now: now() }), listOptions(c.env.DB)]);
  if (!job) return renderError(c, 404);
  // 지원 칸: 비로그인(캐시되는 화면)은 누구에게나 같은 "지원하기" 링크. 로그인한 요청은 캐시를 거치지 않으므로(page-cache)
  // 구직자에게만 "이미 지원함" 을 보이고, 기업·헤드헌터·관리자에게는 지원 버튼 없이 안내만 보인다.
  const user = c.var.user;
  const apply: ApplyState = !user ? 'open'
    : user.role !== 'seeker' ? 'not_seeker'
    : (await hasApplied(c.env.DB, id, user.id)) ? 'applied' : 'open';
  return render(c, <PublicJobPage locale={c.var.locale} job={job} options={buildOptionSet(optionRows)} apply={apply} />, { text: job.title_ko ?? '' });
});
