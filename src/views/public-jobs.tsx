// 공개 공고 목록·상세 (구직자 화면). 공고 글은 기업이 쓴 원문을 엔진이 옮긴 것이므로 믿을 수 없는 글로 보고
// JSX 로만 출력한다 (자동 이스케이프, 줄바꿈은 .pre = white-space: pre-wrap). 공고 글은 한국어로만 게재된다 —
// 중국어 화면에서도 제목·본문은 한국어 그대로 보이고, 화면 문구만 중국어가 된다. 중국어 원문은 보여주지 않는다.
// 지원(T-08): 구직자 본인이 "지원하기" 를 눌러 지원 화면(/jobs/:id/apply)으로 간다. 운영자는 연결·추천하지 않는다 (직업정보제공사업).
// 비로그인 화면은 캐시되므로(page-cache) 지원 칸에 사용자별 내용을 넣지 않는다 — 누구에게나 같은 "지원하기" 링크.
// 기업이 입력한 연락처도 그대로 보여준다.
import type { Locale } from '../env';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import { labelOf, type OptionSet } from '../lib/options';
import { activeFilterCount, FILTER_KEYS, isOptionFilter, jobsHref, type FilterChoices, type FilterKey, type JobFilter } from '../lib/public-jobs';
import type { PublicJobDetail, PublicJobListRow } from '../db/public-jobs';
import { salaryText } from './jobs';

/** 필터 이름 → 칸 이름 문구 키. 공고 작성·기업 정보 화면의 문구를 그대로 쓴다 (관리자 설정 화면도 쓴다). */
export const FILTER_LABELS: Record<FilterKey, string> = {
  chinese_level: 'job.f.chinese_level',
  role_category: 'job.f.role_category',
  industry: 'job.f.industry',
  entry_stage: 'co.f.entry_stage',
  salary_basis: 'job.f.salary_basis',
  report_line: 'job.f.report_line',
  location: 'job.f.location',
};

/** 고정 목록 필터의 값 문구 키 앞부분. 직무·업계·근무지는 job_options 의 이름을 쓴다 (labelOf). */
const FIXED_VALUE_PREFIX: Record<Exclude<FilterKey, 'role_category' | 'industry' | 'location'>, string> = {
  chinese_level: 'job.chinese_level',
  entry_stage: 'co.stage',
  salary_basis: 'job.salary_basis',
  report_line: 'job.report_line',
};

const filterValueLabel = (locale: Locale, options: OptionSet, k: FilterKey, v: string): string =>
  isOptionFilter(k) ? labelOf(options, k, v, locale) : t(locale, `${FIXED_VALUE_PREFIX[k]}.${v}`);

const choice = (locale: Locale, prefix: string, v: string | null): string => (v ? t(locale, `${prefix}.${v}`) : '');

/** 연봉 표시: "5,000 ~ 7,000 만원/년 (퇴직금 별도)". 연봉을 적지 않은 공고는 "협의". */
export function publicSalaryText(locale: Locale, j: Pick<PublicJobListRow, 'salary_min' | 'salary_max' | 'salary_basis'>): string {
  return salaryText(locale, j) || t(locale, 'pj.salary.negotiable');
}

/** 마감일 표시. 마감일이 없으면 "상시". */
export const closesText = (locale: Locale, closesAt: number | null): string =>
  closesAt == null ? t(locale, 'pj.closes.none') : fmtDate(closesAt);

const CompanyName = ({ locale, row, link = true }: { locale: Locale; row: Pick<PublicJobListRow, 'company_id' | 'company_name'>; link?: boolean }) =>
  row.company_name == null ? <span class="muted">{t(locale, 'pj.company_hidden')}</span>
    : link && row.company_id ? <a href={`/companies/${row.company_id}`}>{row.company_name}</a>
    : <span>{row.company_name}</span>;

// ── 목록 한 줄 (목록·홈 공통)

export const PublicJobItem = ({ locale, row, options }: { locale: Locale; row: PublicJobListRow; options: OptionSet }) => {
  const meta = [
    labelOf(options, 'location', row.location, locale),
    labelOf(options, 'role_category', row.role_category, locale),
    labelOf(options, 'industry', row.industry, locale),
  ].filter(Boolean).join(' · ');
  return (
    <li class="job">
      <a href={`/jobs/${row.id}`} lang="ko">{row.title_ko || t(locale, 'job.untitled')}</a>
      <div><CompanyName locale={locale} row={row} /></div>
      {meta && <div class="muted">{meta}</div>}
      <div class="facts-line">
        <span>{t(locale, 'job.f.salary')} {publicSalaryText(locale, row)}</span>
        {row.report_line && <span>{t(locale, 'job.f.report_line')} {choice(locale, 'job.report_line', row.report_line)}</span>}
        {row.chinese_level && <span>{t(locale, 'pj.chinese')} {choice(locale, 'job.chinese_level', row.chinese_level)}</span>}
        <span>{t(locale, 'job.f.closes_at')} {closesText(locale, row.closes_at)}</span>
      </div>
    </li>
  );
};

// ── 목록

/**
 * 검색 칸. enabled(관리자 설정, FILTER_KEYS 순서)에 있는 필터만 보인다. 하나도 없으면 폼 전체를 그리지 않는다.
 * 고를 수 있는 값은 choices (직무·업계·근무지는 사용 중인 항목만, lib/public-jobs.filterChoices).
 */
const FilterForm = ({ locale, filter, enabled, choices, options }: {
  locale: Locale; filter: JobFilter; enabled: readonly FilterKey[]; choices: FilterChoices; options: OptionSet;
}) => {
  if (enabled.length === 0) return null;
  const n = activeFilterCount(filter);
  return (
    <form method="get" action="/jobs" class="box">
      <div class="grid3">
        {FILTER_KEYS.filter((k) => enabled.includes(k)).map((k) => {
          return (
            <label>{t(locale, FILTER_LABELS[k])}
              <select name={k}>
                <option value="">{t(locale, 'pj.filter.any')}</option>
                {choices[k].map((v) => (
                  <option value={v} selected={filter[k] === v}>{filterValueLabel(locale, options, k, v)}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <div class="actions">
        <button type="submit">{t(locale, 'pj.filter.submit')}</button>
        {n > 0 && (
          <>
            <span class="muted">{t(locale, 'pj.filter.active').replace('{n}', String(n))}</span>
            <a href="/jobs">{t(locale, 'pj.filter.reset')}</a>
          </>
        )}
      </div>
    </form>
  );
};

export interface PublicJobListProps {
  locale: Locale;
  filter: JobFilter;
  /** 보일 필터 (lib/public-jobs.parseEnabledFilters). 목록 줄·상세는 이 값과 관계없이 모든 항목을 보인다. */
  enabled: readonly FilterKey[];
  /** 검색 칸에서 고를 수 있는 값 (lib/public-jobs.filterChoices). */
  choices: FilterChoices;
  /** 직무·업계·근무지 이름 (사용 종료된 항목도 목록 줄에는 이름이 보인다). */
  options: OptionSet;
  rows: PublicJobListRow[];
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export const PublicJobList = (p: PublicJobListProps) => (
  <section class="wide">
    <h1>{t(p.locale, 'pj.title')}</h1>
    <p class="muted sub">{t(p.locale, 'pj.lead')}</p>
    <FilterForm locale={p.locale} filter={p.filter} enabled={p.enabled} choices={p.choices} options={p.options} />
    {p.rows.length === 0 ? (
      <div class="box">
        <p>{t(p.locale, p.page > 1 ? 'pj.empty_page' : 'pj.empty')}</p>
        {p.page > 1 && <p><a href={jobsHref(p.filter)}>{t(p.locale, 'pj.first_page')}</a></p>}
      </div>
    ) : (
      <ul class="list">{p.rows.map((r) => <PublicJobItem locale={p.locale} row={r} options={p.options} />)}</ul>
    )}
    {(p.hasPrev || p.hasNext) && (
      <nav class="pager" aria-label={t(p.locale, 'pj.pager')}>
        {p.hasPrev ? <a href={jobsHref(p.filter, p.page - 1)} rel="prev">{t(p.locale, 'pj.prev')}</a> : <span />}
        <span class="muted">{t(p.locale, 'pj.page').replace('{n}', String(p.page))}</span>
        {p.hasNext ? <a href={jobsHref(p.filter, p.page + 1)} rel="next">{t(p.locale, 'pj.next')}</a> : <span />}
      </nav>
    )}
  </section>
);

// ── 상세

/**
 * 지원 칸의 모양. 'open' = 누구에게나 같은 "지원하기" 링크 (비로그인 캐시 화면도 이것), 'applied' = 로그인한 구직자가 이미 지원함,
 * 'not_seeker' = 기업·헤드헌터·관리자 계정 (지원 버튼 없이 안내만).
 */
export type ApplyState = 'open' | 'applied' | 'not_seeker';

const ApplyBox = ({ locale, jobId, state }: { locale: Locale; jobId: string; state: ApplyState }) => (
  <div class="box">
    <h2>{t(locale, 'pj.apply')}</h2>
    {state === 'open' && (
      <>
        <p>{t(locale, 'pj.apply_note')}</p>
        <p><a class="button" href={`/jobs/${jobId}/apply`}>{t(locale, 'pj.apply_button')}</a></p>
      </>
    )}
    {state === 'applied' && <p>{t(locale, 'pj.applied')} · <a href="/my/applications">{t(locale, 'pj.applied_link')}</a></p>}
    {state === 'not_seeker' && <p class="muted">{t(locale, 'pj.apply_seeker_only')}</p>}
    <p class="hint">{t(locale, 'pj.apply_who')}</p>
  </div>
);

export const PublicJobPage = ({ locale, job, options, apply = 'open' }: { locale: Locale; job: PublicJobDetail; options: OptionSet; apply?: ApplyState }) => {
  const conditions: [string, string][] = [
    ['job.f.salary', publicSalaryText(locale, job)],
    ['job.f.work_hours', job.work_hours ?? ''],
    ['job.f.report_line', choice(locale, 'job.report_line', job.report_line)],
    ['job.f.chinese_level', choice(locale, 'job.chinese_level', job.chinese_level)],
    ['job.f.location', labelOf(options, 'location', job.location, locale)],
    ['job.f.role_category', labelOf(options, 'role_category', job.role_category, locale)],
    ['job.f.industry', labelOf(options, 'industry', job.industry, locale)],
    ['job.f.closes_at', closesText(locale, job.closes_at)],
    ['pj.published', job.published_at ? fmtDate(job.published_at) : ''],
  ];
  return (
    <section class="wide">
      <p class="crumbs"><a href="/jobs">{t(locale, 'pj.title')}</a></p>
      <h1 lang="ko">{job.title_ko || t(locale, 'job.untitled')}</h1>
      <p class="sub"><CompanyName locale={locale} row={job} /></p>
      {locale !== 'ko' && <p class="hint">{t(locale, 'pj.lang_note')}</p>}

      <ul class="facts">
        <li>
          <span>{t(locale, 'job.f.salary')}</span>
          <b>{publicSalaryText(locale, job)}</b>
        </li>
        <li>
          <span>{t(locale, 'job.f.report_line')}</span>
          <b>{choice(locale, 'job.report_line', job.report_line) || t(locale, 'job.none')}</b>
          <small class="muted">{t(locale, 'pj.report_line_hint')}</small>
        </li>
        <li>
          <span>{t(locale, 'job.f.chinese_level')}</span>
          <b>{choice(locale, 'job.chinese_level', job.chinese_level) || t(locale, 'job.none')}</b>
        </li>
      </ul>

      <div class="box">
        <h2>{t(locale, 'job.form.conditions')}</h2>
        <dl class="kv">
          {conditions.map(([k, v]) => (<><dt>{t(locale, k)}</dt><dd>{v || <span class="muted">{t(locale, 'job.none')}</span>}</dd></>))}
        </dl>
      </div>

      <div class="box">
        <h2>{t(locale, 'pj.body')}</h2>
        {job.body_ko?.trim() ? <div class="pre" lang="ko">{job.body_ko}</div> : <p class="muted">{t(locale, 'job.none')}</p>}
        <p class="hint">{t(locale, 'pub.provided_note')}</p>
      </div>

      <div class="box">
        <h2>{t(locale, 'pj.company')}</h2>
        <dl class="kv">
          <dt>{t(locale, 'pj.company_name')}</dt>
          <dd><CompanyName locale={locale} row={job} />{job.company_name_zh && <span class="muted"> · {job.company_name_zh}</span>}</dd>
          {job.entry_stage && (<><dt>{t(locale, 'co.f.entry_stage')}</dt><dd>{t(locale, `co.stage.${job.entry_stage}`)}</dd></>)}
        </dl>
        {job.company_id && <p><a href={`/companies/${job.company_id}`}>{t(locale, 'pj.company_page')}</a></p>}
        <p class="hint">{t(locale, 'pub.provided_note')}</p>
      </div>

      <ApplyBox locale={locale} jobId={job.id} state={apply} />

      <div class="box">
        <h2>{t(locale, 'pj.contact')}</h2>
        <p>{t(locale, 'pj.contact_note')}</p>
        {job.contact_email
          ? <p><a href={`mailto:${job.contact_email}`}>{job.contact_email}</a></p>
          : <p class="muted">{t(locale, 'job.none')}</p>}
        <p class="hint">{t(locale, 'pj.contact_who')}</p>
      </div>

      <p><a href="/jobs">{t(locale, 'pj.back')}</a></p>
    </section>
  );
};
