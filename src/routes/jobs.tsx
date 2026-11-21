// 공개 공고 목록·상세 (/jobs, /jobs/:id) 와 홈(/). 누구나 볼 수 있다.
// 공개 조건은 db/public-jobs.publicJobWhere (= lib/public-jobs.isPubliclyVisible) 하나다. 보이지 않는 공고는 보통의 404 — 있는지 알리지 않는다.
// 로그인하지 않은 요청은 lib/page-cache 의 캐시를 거친다 (60초).
import { Hono, type Context } from 'hono';
import { flagsOf, now, type AppEnv } from '../env';
import { findPublicJob, listPublicJobs } from '../db/public-jobs';
import { canonicalJobHref, canonicalJobsHref, HOME_JOB_COUNT, isJobId, pageOf, pageQuery, parseJobFilter, parsePage } from '../lib/public-jobs';
import { pageCache } from '../lib/page-cache';
import { render, renderError } from '../render';
import { Home } from '../views/pages';
import { PublicJobList, PublicJobPage } from '../views/public-jobs';

export const jobs = new Hono<AppEnv>();

/** 홈 (index.tsx 에서 '/' 에 붙인다). */
export async function homePage(c: Context<AppEnv>) {
  const rows = await listPublicJobs(c.env.DB, { flags: flagsOf(c.env), now: now(), filter: {}, limit: HOME_JOB_COUNT, offset: 0 });
  return render(c, <Home locale={c.var.locale} jobs={rows} />);
}

/** 요청 주소(경로 + 검색 조건)가 정규화 주소와 다른가. */
const differs = (c: Context<AppEnv>, href: string): boolean => {
  const u = new URL(c.req.url);
  return u.pathname + u.search !== href;
};

jobs.get('/', pageCache, async (c) => {
  // 빈 칸·모르는 조건·page=1 이 붙은 주소는 정규화 주소로 보낸다 (DB 를 읽지 않는다. 302 는 캐시하지 않는다).
  const canonical = canonicalJobsHref(c.req.query());
  if (differs(c, canonical)) return c.redirect(canonical, 302);
  const filter = parseJobFilter(c.req.query());
  const page = parsePage(c.req.query('page'));
  const { limit, offset } = pageQuery(page);
  const rows = await listPublicJobs(c.env.DB, { flags: flagsOf(c.env), now: now(), filter, limit, offset });
  const pg = pageOf(rows, page);
  return render(c, <PublicJobList locale={c.var.locale} filter={filter} {...pg} />, 'pj.title');
});

jobs.get('/:id', pageCache, async (c) => {
  const id = c.req.param('id');
  if (!isJobId(id)) return renderError(c, 404);
  const canonical = canonicalJobHref(id, c.req.query());
  if (differs(c, canonical)) return c.redirect(canonical, 302);
  const job = await findPublicJob(c.env.DB, { id, flags: flagsOf(c.env), now: now() });
  if (!job) return renderError(c, 404);
  return render(c, <PublicJobPage locale={c.var.locale} job={job} />, { text: job.title_ko ?? '' });
});
