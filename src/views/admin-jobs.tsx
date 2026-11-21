// 관리자 공고 화면. 관리자는 공고 내용을 고칠 수 없다 — 이 화면에는 수정 폼·게재 버튼이 없다.
// 엔진 출력·기업이 쓴 글은 JSX 로만 출력한다 (자동 이스케이프).
import type { Locale } from '../env';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import { JOB_LIMITS, type JobStatus } from '../lib/jobs';
import type { CompareResult } from '../routes/admin-jobs';
import type { JobRow } from '../db/jobs';
import { Flash } from './company';
import { JobConditions, JobStatusBadge, LocalizeBadge } from './jobs';

export interface AdminJobListRow {
  id: string; title_ko: string | null; title_zh: string | null; status: JobStatus; review_flag: string | null;
  review_cleared_by: string | null; updated_at: number; company_name: string;
}

const flagText = (l: Locale, f: string) => t(l, `job.flag.${f}`);

export const AdminJobList = ({ locale, rows }: { locale: Locale; rows: AdminJobListRow[] }) => (
  <section class="wide">
    <p class="crumbs"><a href="/admin">{t(locale, 'admin.title')}</a></p>
    <h1>{t(locale, 'adm.job.title')}</h1>
    <p class="muted">{t(locale, 'adm.job.lead')}</p>
    {rows.length === 0 ? <p class="muted">{t(locale, 'adm.job.empty')}</p> : (
      <div class="box">
        <table>
          <thead><tr>
            <th>{t(locale, 'job.f.title_ko')}</th><th>{t(locale, 'adm.job.company')}</th><th>{t(locale, 'job.status')}</th>
            <th>{t(locale, 'adm.job.flag')}</th><th>{t(locale, 'job.updated')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td><a href={`/admin/jobs/${r.id}`}>{r.title_ko || r.title_zh || t(locale, 'job.untitled')}</a></td>
                <td>{r.company_name}</td>
                <td><JobStatusBadge locale={locale} status={r.status} /></td>
                <td>{r.review_flag && !r.review_cleared_by ? flagText(locale, r.review_flag) : ''}</td>
                <td>{fmtDate(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <p><a href="/admin/localize-test">{t(locale, 'adm.lt.title')}</a></p>
  </section>
);

export interface AdminJobDetailProps {
  locale: Locale;
  job: JobRow;
  company: { name_ko: string; verify_status: string } | null;
  ok?: string;
  error?: string;
}

export const AdminJobDetail = (p: AdminJobDetailProps) => {
  const l = p.locale;
  const j = p.job;
  const flagged = !!j.review_flag && !j.review_cleared_by;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin/jobs">{t(l, 'adm.job.title')}</a></p>
      <h1>{j.title_ko || j.title_zh || t(l, 'job.untitled')}</h1>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <div class="box">
        <dl class="kv">
          <dt>{t(l, 'adm.job.company')}</dt>
          <dd>{p.company ? <a href={`/admin/companies/${j.company_id}`}>{p.company.name_ko}</a> : ''}
            {p.company && <span class="muted"> ({t(l, `co.status.${p.company.verify_status}`)})</span>}</dd>
          <dt>{t(l, 'job.status')}</dt><dd><JobStatusBadge locale={l} status={j.status} /></dd>
          <dt>{t(l, 'job.loc')}</dt><dd><LocalizeBadge locale={l} status={j.localize_status} /></dd>
          <dt>{t(l, 'adm.job.flag')}</dt>
          <dd>{j.review_flag ? `${flagText(l, j.review_flag)}${j.review_cleared_by ? ` — ${t(l, 'adm.job.cleared')}` : ''}` : t(l, 'job.none')}</dd>
          <dt>{t(l, 'adm.job.engine')}</dt><dd>{j.localize_engine ?? t(l, 'adm.job.engine_none')}</dd>
          <dt>{t(l, 'job.updated')}</dt><dd>{fmtDate(j.updated_at)}</dd>
          {j.block_reason && (<><dt>{t(l, 'job.blocked_reason')}</dt><dd class="pre">{j.block_reason}</dd></>)}
        </dl>
      </div>

      <div class="box">
        <h2>{t(l, 'job.review.korean')}</h2>
        <p class="col-title">{j.title_ko ?? ''}</p>
        {j.body_ko ? <div class="pre">{j.body_ko}</div> : <p class="muted">{t(l, 'job.review.no_korean')}</p>}
      </div>
      <div class="box">
        <h2>{t(l, 'job.review.source')}</h2>
        <p class="col-title">{j.title_zh ?? ''}</p>
        <div class="pre" lang="zh">{j.source_zh ?? ''}</div>
      </div>
      {j.back_zh && (
        <div class="box">
          <h2>{t(l, 'job.review.back')}</h2>
          <div class="pre" lang="zh">{j.back_zh}</div>
        </div>
      )}
      <div class="box">
        <h2>{t(l, 'job.form.conditions')}</h2>
        <JobConditions locale={l} job={j} />
      </div>

      <div class="box">
        <h2>{t(l, 'adm.job.decide')}</h2>
        <p class="muted">{t(l, 'adm.job.no_edit')}</p>
        {flagged && j.status !== 'blocked' && (
          <form method="post" action={`/admin/jobs/${j.id}/clear-review`}>
            <input type="hidden" name="rev" value={String(j.rev)} />
            <p>{t(l, 'adm.job.clear_note')}</p>
            <button type="submit">{t(l, 'adm.job.clear')}</button>
          </form>
        )}
        {j.status === 'blocked' ? (
          <form method="post" action={`/admin/jobs/${j.id}/unblock`} class="spaced">
            <p>{t(l, 'adm.job.unblock_note')}</p>
            <button type="submit" class="plain">{t(l, 'adm.job.unblock')}</button>
          </form>
        ) : (
          <form method="post" action={`/admin/jobs/${j.id}/block`} class="spaced">
            <label>{t(l, 'adm.job.block_reason')}
              <textarea name="reason" rows={3} required maxlength={JOB_LIMITS.reason}></textarea>
              <span class="hint">{t(l, 'adm.co.reason_hint')}</span>
            </label>
            <button type="submit" class="secondary">{t(l, 'adm.job.block')}</button>
          </form>
        )}
      </div>
    </section>
  );
};

export interface LocalizeTestProps {
  locale: Locale;
  all: string[];
  available: string[];
  selected: string[];
  input: { title: string; body: string };
  results: CompareResult[];
  error?: string;
}

/** 엔진 비교. 엔진 id 는 관리자에게만 보인다. */
export const LocalizeTestPage = (p: LocalizeTestProps) => {
  const l = p.locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a> · <a href="/admin/jobs">{t(l, 'adm.job.title')}</a></p>
      <h1>{t(l, 'adm.lt.title')}</h1>
      <p class="muted">{t(l, 'adm.lt.lead')}</p>
      <Flash locale={l} error={p.error} />
      <div class="box">
        <form method="post" action="/admin/localize-test">
          <label>{t(l, 'job.f.title_zh')}
            <input name="title" required maxlength={JOB_LIMITS.title} value={p.input.title} lang="zh" />
          </label>
          <label>{t(l, 'job.f.source_zh')}
            <textarea name="body" rows={10} required maxlength={JOB_LIMITS.body} lang="zh">{p.input.body}</textarea>
            <span class="hint">{t(l, 'adm.lt.hint')}</span>
          </label>
          <fieldset>
            <legend>{t(l, 'adm.lt.engines')}</legend>
            {p.all.map((id) => {
              const on = p.available.includes(id);
              return (
                <label class="check">
                  <input type="checkbox" name="engines" value={id} disabled={!on} checked={on && p.selected.includes(id)} />
                  {id}{!on && <span class="muted"> — {t(l, 'adm.lt.unavailable')}</span>}
                </label>
              );
            })}
            {p.available.length === 0 && <p class="muted">{t(l, 'adm.lt.none')}</p>}
          </fieldset>
          <button type="submit" disabled={p.available.length === 0}>{t(l, 'adm.lt.run')}</button>
        </form>
      </div>
      {p.results.length > 0 && (
        <div class="box">
          <h2>{t(l, 'adm.lt.results')}</h2>
          <div class="cols3">
            {p.results.map((r) => (
              <div>
                <h3>{r.id} <span class="muted">{r.run.ms} ms</span></h3>
                {r.run.ok ? (
                  <>
                    <p class="muted">{t(l, 'job.review.korean')}</p>
                    <p class="col-title">{r.run.title_ko}</p>
                    <div class="pre">{r.run.body_ko}</div>
                    <p class="muted spaced">{t(l, 'job.review.back')}</p>
                    <div class="pre" lang="zh">{r.run.back_zh}</div>
                  </>
                ) : <p class="error">{t(l, 'adm.lt.failed')}: {r.run.error}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
