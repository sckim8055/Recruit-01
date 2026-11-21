// 기업 공고 화면. 엔진 출력은 믿을 수 없는 글이므로 JSX 로만 출력한다 (자동 이스케이프, 줄바꿈은 .pre = white-space: pre-wrap).
// 기업 화면에는 현지화 엔진 이름을 보여주지 않는다.
import type { Locale } from '../env';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import {
  CHINESE_LEVELS, INDUSTRIES, JOB_LIMITS, LOCATIONS, REPORT_LINES, ROLE_CATEGORIES, SALARY_BASES, SALARY_MAX,
  type JobFieldError, type JobFormField, type JobInput, type JobStatus, type LocalizeStatus,
} from '../lib/jobs';
import type { PublishBlock } from '../lib/rules';
import type { JobRow } from '../routes/job-db';
import { Flash } from './company';

// ── 공통 조각

export const JobStatusBadge = ({ locale, status }: { locale: Locale; status: JobStatus }) => (
  <span class={`badge s-${status}`}>{t(locale, `job.status.${status}`)}</span>
);

export const LocalizeBadge = ({ locale, status }: { locale: Locale; status: LocalizeStatus }) => (
  <span class={`badge l-${status}`}>{t(locale, `job.loc.${status}`)}</span>
);

export const blockText = (locale: Locale, b: PublishBlock): string => t(locale, `job.block.${b}`);

const fieldLabel = (locale: Locale, f: JobFieldError['field']) => t(locale, `job.f.${f}`);

export const JobFieldErrors = ({ locale, errors }: { locale: Locale; errors: JobFieldError[] }) =>
  errors.length ? (
    <ul class="error">{errors.map((e) => <li>{fieldLabel(locale, e.field)}: {t(locale, `job.err.${e.code}`)}</li>)}</ul>
  ) : null;

/** 여러 줄 글. 비어 있으면 안내 문구. */
const TextBlock = ({ locale, text, emptyKey }: { locale: Locale; text: string | null; emptyKey: string }) =>
  text?.trim() ? <div class="pre">{text}</div> : <p class="muted">{t(locale, emptyKey)}</p>;

const choiceText = (locale: Locale, prefix: string, v: string | null) => (v ? t(locale, `${prefix}.${v}`) : '');

export function salaryText(locale: Locale, j: Pick<JobRow, 'salary_min' | 'salary_max' | 'salary_basis'>): string {
  if (j.salary_min == null && j.salary_max == null) return '';
  const n = (x: number) => x.toLocaleString('en-US');
  const range = j.salary_max != null && j.salary_max !== j.salary_min ? `${n(j.salary_min ?? 0)} ~ ${n(j.salary_max)}` : n(j.salary_min ?? j.salary_max!);
  const basis = j.salary_basis ? ` (${t(locale, `job.salary_basis.${j.salary_basis}`)})` : '';
  return `${range} ${t(locale, 'job.unit.salary')}${basis}`;
}

/** 구조 항목. 공개 화면(T-06)에 표시될 연봉·근무시간은 이 값 그대로다 (번역하지 않는다). */
export const JobConditions = ({ locale, job }: { locale: Locale; job: JobRow }) => {
  const rows: [string, string][] = [
    ['job.f.role_category', choiceText(locale, 'job.role', job.role_category)],
    ['job.f.industry', choiceText(locale, 'job.industry', job.industry)],
    ['job.f.location', choiceText(locale, 'job.location', job.location)],
    ['job.f.salary', salaryText(locale, job)],
    ['job.f.work_hours', job.work_hours ?? ''],
    ['job.f.report_line', choiceText(locale, 'job.report_line', job.report_line)],
    ['job.f.chinese_level', choiceText(locale, 'job.chinese_level', job.chinese_level)],
    ['job.f.contact_email', job.contact_email ?? ''],
    ['job.f.closes_at', job.closes_at ? fmtDate(job.closes_at) : ''],
  ];
  return (
    <dl class="kv">
      {rows.map(([k, v]) => (<><dt>{t(locale, k)}</dt><dd>{v || <span class="muted">{t(locale, 'job.none')}</span>}</dd></>))}
    </dl>
  );
};

const JobNav = ({ locale }: { locale: Locale }) => (
  <p class="crumbs"><a href="/biz">{t(locale, 'biz.title')}</a> · <a href="/biz/jobs">{t(locale, 'job.list.title')}</a></p>
);

// ── 목록

export interface JobListRow {
  id: string; title_zh: string | null; title_ko: string | null; status: JobStatus; localize_status: LocalizeStatus;
  review_flag: string | null; review_cleared_by: string | null; updated_at: number;
}

export const JobList = ({ locale, rows, verified }: { locale: Locale; rows: JobListRow[]; verified: boolean }) => (
  <section class="wide">
    <p class="crumbs"><a href="/biz">{t(locale, 'biz.title')}</a></p>
    <h1>{t(locale, 'job.list.title')}</h1>
    {!verified && <p class="muted">{t(locale, 'job.list.unverified')}</p>}
    <p><a class="button" href="/biz/jobs/new">{t(locale, 'job.new')}</a></p>
    {rows.length === 0 ? <p class="muted">{t(locale, 'job.list.empty')}</p> : (
      <div class="box">
        <table>
          <thead><tr>
            <th>{t(locale, 'job.f.title_zh')}</th><th>{t(locale, 'job.status')}</th><th>{t(locale, 'job.loc')}</th><th>{t(locale, 'job.updated')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a href={`/biz/jobs/${r.id}`}>{r.title_zh || t(locale, 'job.untitled')}</a>
                  {r.title_ko && <div class="muted">{r.title_ko}</div>}
                  {r.review_flag && !r.review_cleared_by && <div class="hint">{t(locale, 'job.review_pending')}</div>}
                </td>
                <td><JobStatusBadge locale={locale} status={r.status} /></td>
                <td><LocalizeBadge locale={locale} status={r.localize_status} /></td>
                <td>{fmtDate(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

// ── 작성·편집 폼

export interface JobFormProps {
  locale: Locale;
  action: string;
  input: JobInput;
  errors: JobFieldError[];
  productionJobs: boolean;
  jobId?: string;
  rev?: number;
  error?: string;
}

const Select = ({ locale, name, list, prefix, value, required }: {
  locale: Locale; name: JobFormField; list: readonly string[]; prefix: string; value: string; required?: boolean;
}) => (
  <select name={name} required={required}>
    <option value="">{t(locale, 'common.choose')}</option>
    {list.map((v) => <option value={v} selected={value === v}>{t(locale, `${prefix}.${v}`)}</option>)}
  </select>
);

export const JobFormPage = (p: JobFormProps) => {
  const l = p.locale;
  const i = p.input;
  return (
    <section class="wide">
      <JobNav locale={l} />
      <h1>{t(l, p.jobId ? 'job.edit.title' : 'job.new')}</h1>
      <Flash locale={l} error={p.error} />
      <form method="post" action={p.action}>
        {p.rev !== undefined && <input type="hidden" name="rev" value={String(p.rev)} />}
        <JobFieldErrors locale={l} errors={p.errors} />
        <div class="box">
          <h2>{t(l, 'job.form.source')}</h2>
          <p class="muted">{t(l, 'job.form.source_lead')}</p>
          <label>{t(l, 'job.f.title_zh')} *
            <input name="title_zh" required maxlength={JOB_LIMITS.title} value={i.title_zh} lang="zh" />
          </label>
          <label>{t(l, 'job.f.source_zh')} *
            <textarea name="source_zh" rows={14} required maxlength={JOB_LIMITS.body} lang="zh">{i.source_zh}</textarea>
            <span class="hint">{t(l, 'job.hint.source_zh')}</span>
          </label>
        </div>
        <div class="box">
          <h2>{t(l, 'job.form.conditions')}</h2>
          <p class="muted">{t(l, 'job.form.conditions_lead')}</p>
          {p.productionJobs ? (
            <label>{t(l, 'job.f.job_family')}
              <select name="job_family">
                {(['office', 'production'] as const).map((v) => <option value={v} selected={i.job_family === v}>{t(l, `job.family.${v}`)}</option>)}
              </select>
            </label>
          ) : <input type="hidden" name="job_family" value="office" />}
          <div class="grid2">
            <label>{t(l, 'job.f.role_category')}<Select locale={l} name="role_category" list={ROLE_CATEGORIES} prefix="job.role" value={i.role_category} /></label>
            <label>{t(l, 'job.f.industry')}<Select locale={l} name="industry" list={INDUSTRIES} prefix="job.industry" value={i.industry} /></label>
            <label>{t(l, 'job.f.location')}<Select locale={l} name="location" list={LOCATIONS} prefix="job.location" value={i.location} /></label>
            <label>{t(l, 'job.f.chinese_level')}<Select locale={l} name="chinese_level" list={CHINESE_LEVELS} prefix="job.chinese_level" value={i.chinese_level} /></label>
            <label>{t(l, 'job.f.report_line')}<Select locale={l} name="report_line" list={REPORT_LINES} prefix="job.report_line" value={i.report_line} /></label>
            <label>{t(l, 'job.f.closes_at')}<input type="date" name="closes_at" value={i.closes_at} /></label>
          </div>
          <fieldset>
            <legend>{t(l, 'job.f.salary')} ({t(l, 'job.unit.salary')})</legend>
            <div class="grid3">
              <label>{t(l, 'job.f.salary_min')}<input name="salary_min" inputmode="numeric" pattern="[0-9,]*" maxlength={7} value={i.salary_min} /></label>
              <label>{t(l, 'job.f.salary_max')}<input name="salary_max" inputmode="numeric" pattern="[0-9,]*" maxlength={7} value={i.salary_max} /></label>
              <label>{t(l, 'job.f.salary_basis')}<Select locale={l} name="salary_basis" list={SALARY_BASES} prefix="job.salary_basis" value={i.salary_basis} /></label>
            </div>
            <span class="hint">{t(l, 'job.hint.salary').replace('{max}', SALARY_MAX.toLocaleString('en-US'))}</span>
          </fieldset>
          <fieldset>
            <legend>{t(l, 'job.f.work_hours')}</legend>
            <div class="grid3">
              <label>{t(l, 'job.f.work_start')}<input type="time" name="work_start" value={i.work_start} /></label>
              <label>{t(l, 'job.f.work_end')}<input type="time" name="work_end" value={i.work_end} /></label>
            </div>
          </fieldset>
          <label>{t(l, 'job.f.contact_email')}
            <input type="email" name="contact_email" maxlength={254} value={i.contact_email} autocomplete="off" />
            <span class="hint">{t(l, 'job.hint.contact_email')}</span>
          </label>
        </div>
        <button type="submit">{t(l, 'common.save')}</button>
        {p.jobId && <> <a href={`/biz/jobs/${p.jobId}`}>{t(l, 'common.back')}</a></>}
      </form>
    </section>
  );
};

// ── 확인 화면

export interface JobReviewProps {
  locale: Locale;
  job: JobRow;
  blocks: PublishBlock[];
  digits: { missing: string[]; extra: string[] };
  enginesAvailable: boolean;
  koErrors: JobFieldError[];
  koInput?: { title_ko: string; body_ko: string };
  highlightBlocks?: boolean;
  ok?: string;
  error?: string;
}

export const JobReview = (p: JobReviewProps) => {
  const l = p.locale;
  const j = p.job;
  const closed = j.status === 'closed';
  const hasKo = !!(j.title_ko?.trim() && j.body_ko?.trim());
  const hasSource = !!(j.title_zh?.trim() && j.source_zh?.trim());
  const rev = <input type="hidden" name="rev" value={String(j.rev)} />;
  const digitWarn = hasKo && (p.digits.missing.length > 0 || p.digits.extra.length > 0);
  const ko = p.koInput ?? { title_ko: j.title_ko ?? '', body_ko: j.body_ko ?? '' };
  return (
    <section class="wide">
      <JobNav locale={l} />
      <h1>{j.title_ko || j.title_zh || t(l, 'job.untitled')}</h1>
      <Flash locale={l} ok={p.ok} error={p.error} />

      <div class="box">
        <p>{t(l, 'job.status')}: <JobStatusBadge locale={l} status={j.status} /> · {t(l, 'job.loc')}: <LocalizeBadge locale={l} status={j.localize_status} /></p>
        {j.status === 'blocked' && (
          <>
            <p>{t(l, 'job.blocked_reason')}</p>
            <p class="pre quote">{j.block_reason ?? ''}</p>
            <p class="muted">{t(l, 'job.blocked_note')}</p>
          </>
        )}
        {j.review_flag && !j.review_cleared_by && <p class="muted">{t(l, 'job.review_note')}</p>}
        {j.status === 'draft' && (p.blocks.length > 0 ? (
          <div class={p.highlightBlocks ? 'error' : ''}>
            <p>{t(l, 'job.publish.todo')}</p>
            <ul>{p.blocks.map((b) => <li>{blockText(l, b)}</li>)}</ul>
          </div>
        ) : <p class="muted">{t(l, 'job.publish.ready')}</p>)}
        <div class="actions">
          {j.status === 'draft' && (
            <form method="post" action={`/biz/jobs/${j.id}/publish`} class="inline">
              {rev}<button type="submit" disabled={p.blocks.length > 0}>{t(l, 'job.publish')}</button>
            </form>
          )}
          {j.status === 'published' && (
            <form method="post" action={`/biz/jobs/${j.id}/close`} class="inline">
              <button type="submit" class="secondary">{t(l, 'job.close')}</button>
            </form>
          )}
          {!closed && <a href={`/biz/jobs/${j.id}/edit`}>{t(l, 'job.edit.title')}</a>}
        </div>
        {j.status === 'published' && <p class="hint">{t(l, 'job.published_note')}</p>}
      </div>

      <div class="box">
        <h2>{t(l, 'job.review.title')}</h2>
        <p class="muted">{t(l, 'job.review.lead')}</p>
        <div class="cols3">
          <div>
            <h3>{t(l, 'job.review.source')}</h3>
            <p class="col-title">{j.title_zh ?? ''}</p>
            <TextBlock locale={l} text={j.source_zh} emptyKey="job.none" />
          </div>
          <div>
            <h3>{t(l, 'job.review.korean')}</h3>
            {hasKo ? (<><p class="col-title">{j.title_ko}</p><TextBlock locale={l} text={j.body_ko} emptyKey="job.none" /></>)
              : <p class="muted">{t(l, 'job.review.no_korean')}</p>}
          </div>
          <div>
            <h3>{t(l, 'job.review.back')}</h3>
            {hasKo && j.back_zh?.trim() ? <TextBlock locale={l} text={j.back_zh} emptyKey="job.none" />
              : <p class="muted">{t(l, hasKo ? 'job.review.no_back' : 'job.review.no_korean')}</p>}
          </div>
        </div>
        {digitWarn && (
          <div class="warn">
            <p>{t(l, 'job.digits.warn')}</p>
            {p.digits.missing.length > 0 && <p>{t(l, 'job.digits.missing')}: {p.digits.missing.join(', ')}</p>}
            {p.digits.extra.length > 0 && <p>{t(l, 'job.digits.extra')}: {p.digits.extra.join(', ')}</p>}
          </div>
        )}
        {!closed && (
          <div class="actions">
            {p.enginesAvailable && hasSource && (
              <form method="post" action={`/biz/jobs/${j.id}/localize`} class="inline">
                {rev}
                {hasKo && <input type="hidden" name="again" value="1" />}
                <button type="submit" class={hasKo ? 'plain' : ''}>{t(l, hasKo ? 'job.localize.again' : 'job.localize')}</button>
              </form>
            )}
            {j.localize_status === 'review' && hasKo && (
              <form method="post" action={`/biz/jobs/${j.id}/approve`} class="inline">
                {rev}<button type="submit">{t(l, 'job.approve')}</button>
              </form>
            )}
          </div>
        )}
        {!closed && (p.enginesAvailable ? <p class="hint">{t(l, 'job.localize.hint')}</p> : <p class="muted">{t(l, 'job.localize.manual')}</p>)}
        {j.localize_status === 'approved' && <p class="hint">{t(l, 'job.approved_note')}</p>}
      </div>

      {!closed && (
        <div class="box">
          <h2>{t(l, hasKo ? 'job.korean.edit' : 'job.korean.write')}</h2>
          <p class="muted">{t(l, 'job.korean.lead')}</p>
          <JobFieldErrors locale={l} errors={p.koErrors} />
          <form method="post" action={`/biz/jobs/${j.id}/korean`}>
            {rev}
            <label>{t(l, 'job.f.title_ko')} *
              <input name="title_ko" required maxlength={JOB_LIMITS.title} value={ko.title_ko} lang="ko" />
            </label>
            <label>{t(l, 'job.f.body_ko')} *
              <textarea name="body_ko" rows={14} required maxlength={JOB_LIMITS.body} lang="ko">{ko.body_ko}</textarea>
            </label>
            <button type="submit" class="plain">{t(l, 'job.korean.save')}</button>
          </form>
        </div>
      )}

      <div class="box">
        <h2>{t(l, 'job.form.conditions')}</h2>
        <JobConditions locale={l} job={j} />
        <p class="hint">{t(l, 'job.conditions_note')}</p>
      </div>
    </section>
  );
};
