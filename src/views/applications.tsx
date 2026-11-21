// 구직자 지원 화면 (/jobs/:id/apply, /my/applications...). 모든 값은 JSX 로 출력한다 (자동 이스케이프).
// 이 화면들은 구직자 본인만 본다. SnapshotFields 는 기업·관리자 열람 화면(views/applicants.tsx)도 같이 쓴다.
// 문구 원칙: 운영자는 지원서를 검토·추천·전달하지 않는다. 지원은 구직자가 직접 "지원하기" 를 눌러서만 생긴다.
import type { Locale } from '../env';
import type { ConsentNeed } from '../lib/application';
import { fmtDate, fmtDateTime } from '../lib/company';
import { t } from '../lib/i18n';
import type { ResumeBody, ResumeFieldError, ResumeFileMeta, ResumeInput } from '../lib/resume';
import type { ApplicationRow, OwnApplicationListRow } from '../db/applications';
import { Flash } from './company';
import { FieldErrors, ResumeFieldInputs, levelText } from './resumes';

/** 지원 화면 위쪽에 보일 공고 정보. companyName 이 null 이면 기업명 비공개 공고다. */
export interface ApplyJob { id: string; title: string | null; companyName: string | null }

const jobTitle = (l: Locale, title: string | null) => title || t(l, 'job.untitled');
const companyText = (l: Locale, name: string | null) => name ?? t(l, 'pj.company_hidden');

const yearsText = (l: Locale, n: number) => (n === 0 ? t(l, 'apply.years.zero') : t(l, 'apply.years').replace('{n}', String(n)));

const Crumbs = ({ locale }: { locale: Locale }) => (
  <p class="crumbs"><a href="/my">{t(locale, 'nav.my')}</a> · <a href="/my/applications">{t(locale, 'app.list.title')}</a></p>
);

const JobHead = ({ locale, job }: { locale: Locale; job: ApplyJob }) => (
  <dl class="kv">
    <dt>{t(locale, 'apply.to.job')}</dt><dd><a href={`/jobs/${job.id}`} lang="ko">{jobTitle(locale, job.title)}</a></dd>
    <dt>{t(locale, 'apply.to.company')}</dt><dd>{companyText(locale, job.companyName)}</dd>
  </dl>
);

// ── 지원: 이력서가 없음

export const ApplyNeedResume = ({ locale, job, hasAny }: { locale: Locale; job: ApplyJob; hasAny: boolean }) => (
  <section class="wide">
    <h1>{t(locale, 'apply.title')}</h1>
    <JobHead locale={locale} job={job} />
    <div class="box">
      <p>{t(locale, 'apply.need_resume')}</p>
      <p class="muted">{t(locale, 'resume.not_ready')}</p>
      <div class="actions">
        <a class="button" href={hasAny ? '/my/resumes' : '/my/resumes/new'}>{t(locale, hasAny ? 'apply.need_resume.edit' : 'apply.need_resume.new')}</a>
        <a href={`/jobs/${job.id}`}>{t(locale, 'common.back')}</a>
      </div>
    </div>
  </section>
);

// ── 지원 1단계: 이력서 고르기

export interface ResumeChoice { id: string; title: string; headline: string; isDefault: boolean; ready: boolean }

export const ApplyChooseResume = (p: { locale: Locale; job: ApplyJob; items: ResumeChoice[]; selected: string | null; error?: string }) => {
  const l = p.locale;
  return (
    <section class="wide">
      <h1>{t(l, 'apply.title')}</h1>
      <p class="sub muted">{t(l, 'apply.step1')}</p>
      <JobHead locale={l} job={p.job} />
      <Flash locale={l} error={p.error} />
      {/* GET 으로 같은 주소에 ?resume=<id> 를 붙인다 — 이 단계에서는 아무것도 저장하지 않는다. */}
      <form method="get" action={`/jobs/${p.job.id}/apply`} class="box">
        <fieldset>
          <legend>{t(l, 'apply.choose')}</legend>
          {p.items.map((r) => (
            <label class={r.ready ? 'check' : 'check muted'}>
              <input type="radio" name="resume" value={r.id} required disabled={!r.ready} checked={r.ready && r.id === p.selected} />
              <span>
                {r.title}
                {r.isDefault && <> <span class="badge s-verified">{t(l, 'resume.default')}</span></>}
                {' '}<span class="muted">{r.headline}</span>
                {!r.ready && <> · <span class="warn">{t(l, 'resume.not_ready')}</span></>}
              </span>
            </label>
          ))}
        </fieldset>
        <div class="actions">
          <button type="submit">{t(l, 'apply.next')}</button>
          <a href="/my/resumes">{t(l, 'apply.manage_resumes')}</a>
          <a href={`/jobs/${p.job.id}`}>{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};

// ── 지원 2단계: 이번 지원에만 쓸 내용 + 확인

export interface ApplyFormProps {
  locale: Locale;
  job: ApplyJob;
  resumeId: string;
  input: ResumeInput;
  errors: ResumeFieldError[];
  file: ResumeFileMeta | null;     // 이력서에 첨부된 파일 (있을 때만 "함께 보내기" 칸)
  includeFile: boolean;
  need: ConsentNeed;
  consentGiven: boolean;
  error?: string;                  // 화면 위 한 줄 (locales 키)
}

export const ApplyForm = (p: ApplyFormProps) => {
  const l = p.locale;
  const company = companyText(l, p.job.companyName);
  return (
    <section class="wide">
      <h1>{t(l, 'apply.title')}</h1>
      <p class="sub muted">{t(l, 'apply.step2')}</p>
      <JobHead locale={l} job={p.job} />
      <Flash locale={l} error={p.error} />
      <FieldErrors locale={l} errors={p.errors.filter((e) => e.field !== 'title')} />
      <form method="post" action={`/jobs/${p.job.id}/apply`} class="box">
        <input type="hidden" name="resume_id" value={p.resumeId} />
        <p class="warn">{t(l, 'apply.edit_note')}</p>
        <ResumeFieldInputs locale={l} input={p.input} errors={p.errors} />
        <fieldset>
          <legend>{t(l, 'resume.f.attachment')}</legend>
          {p.file ? (
            <>
              <p>{p.file.name}</p>
              <label class="check"><input type="checkbox" name="include_file" value="1" checked={p.includeFile} />{t(l, 'apply.include_file')}</label>
            </>
          ) : <p class="muted">{t(l, 'resume.no_file')}</p>}
          <p class="hint">{t(l, 'apply.no_upload_here')}</p>
        </fieldset>

        <div class="box">
          <h2>{t(l, 'apply.confirm.title')}</h2>
          <ul>
            <li>{t(l, 'apply.confirm.to').replace('{company}', company).replace('{job}', jobTitle(l, p.job.title))}</li>
            <li>{t(l, 'apply.confirm.what')}
              {p.file && <> {t(l, 'apply.confirm.what_file').replace('{file}', p.file.name)}</>}</li>
            <li>{t(l, 'apply.confirm.who')}</li>
            <li>{t(l, 'apply.confirm.withdraw')}</li>
          </ul>
        </div>

        {p.need === 'optional' && (
          <fieldset>
            <legend>{t(l, 'apply.consent.optional.title')}</legend>
            <p>{t(l, 'apply.consent.optional.text')}</p>
            <label class="check"><input type="checkbox" name="consent" value="1" checked={p.consentGiven} />{t(l, 'apply.consent.optional.label')}</label>
          </fieldset>
        )}
        {p.need === 'required' && (
          <fieldset>
            <legend>{t(l, 'apply.consent.required.title')} *</legend>
            <p>{t(l, 'apply.consent.required.text')}</p>
            <label class="check"><input type="checkbox" name="consent" value="1" required checked={p.consentGiven} />{t(l, 'apply.consent.required.label')}</label>
          </fieldset>
        )}

        <div class="actions">
          <button type="submit">{t(l, 'apply.submit')}</button>
          <a href={`/jobs/${p.job.id}/apply`}>{t(l, 'apply.other_resume')}</a>
          <a href={`/jobs/${p.job.id}`}>{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};

// ── 지원 현황 목록

const statusText = (l: Locale, s: string) => t(l, `app.status.${s}`);

export const ApplicationList = (p: { locale: Locale; rows: OwnApplicationListRow[]; visible: Set<string> }) => {
  const l = p.locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/my">{t(l, 'nav.my')}</a></p>
      <h1>{t(l, 'app.list.title')}</h1>
      <p class="sub muted">{t(l, 'app.list.lead')}</p>
      {p.rows.length === 0 ? (
        <div class="box">
          <p>{t(l, 'app.list.empty')}</p>
          <p><a href="/jobs">{t(l, 'nav.jobs')}</a></p>
        </div>
      ) : (
        <ul class="list">
          {p.rows.map((r) => (
            <li>
              <div>
                {p.visible.has(r.job_id)
                  ? <a href={`/jobs/${r.job_id}`} lang="ko">{jobTitle(l, r.title_ko)}</a>
                  : <span lang="ko">{jobTitle(l, r.title_ko)}</span>}
                {' '}<span class={r.status === 'withdrawn' ? 'badge' : 'badge s-verified'}>{statusText(l, r.status)}</span>
              </div>
              <div>{companyText(l, r.company_name)}</div>
              <div class="facts-line muted">
                <span>{t(l, 'app.applied_at')} {fmtDate(r.created_at)}</span>
                {r.status_changed_at !== r.created_at && <span>{t(l, 'app.status_at')} {fmtDate(r.status_changed_at)}</span>}
              </div>
              <div class="actions"><a href={`/my/applications/${r.id}`}>{t(l, 'app.view')}</a></div>
            </li>
          ))}
        </ul>
      )}
      <p><a href="/my/resumes">{t(l, 'nav.resumes')}</a></p>
    </section>
  );
};

// ── 지원 한 건

export type SnapshotState = { kind: 'ok'; body: ResumeBody } | { kind: 'deleted' } | { kind: 'unavailable' };

/**
 * 지원서(복사본) 항목. 구직자 본인 화면과 기업·관리자 열람 화면이 같은 조각을 쓴다 — 기업이 보는 것 = 구직자가 보낸 것.
 * 첨부파일: fileHref 가 있으면 이름을 링크로, fileForm 이 있으면 POST 버튼으로(관리자: 사유를 함께 보냄). 둘 다 없으면(파일 키 없음) "첨부파일 없음".
 */
export const SnapshotFields = (p: {
  locale: Locale; body: ResumeBody; fileHref?: string | null; fileForm?: { action: string; reason: string } | null;
}) => {
  const l = p.locale;
  const b = p.body;
  const none = <span class="muted">{t(l, 'job.none')}</span>;
  return (
    <dl class="kv">
      <dt>{t(l, 'resume.f.name')}</dt><dd>{b.name}</dd>
      <dt>{t(l, 'resume.f.contact_email')}</dt><dd>{b.contact_email}</dd>
      <dt>{t(l, 'resume.f.phone')}</dt><dd>{b.phone ?? none}</dd>
      <dt>{t(l, 'resume.f.chinese_level')}</dt><dd>{levelText(l, b.chinese_level)}</dd>
      <dt>{t(l, 'resume.f.years')}</dt><dd>{yearsText(l, b.years)}</dd>
      <dt>{t(l, 'resume.f.headline')}</dt><dd>{b.headline}</dd>
      <dt>{t(l, 'resume.f.desired_role')}</dt><dd>{b.desired_role ?? none}</dd>
      <dt>{t(l, 'resume.f.experience_text')}</dt><dd>{b.experience_text ? <div class="pre">{b.experience_text}</div> : none}</dd>
      <dt>{t(l, 'resume.f.attachment')}</dt>
      <dd>
        {b.file && p.fileHref ? <a href={p.fileHref}>{b.file.name}</a>
          : b.file && p.fileForm ? (
            <form method="post" action={p.fileForm.action} class="inline">
              <input type="hidden" name="reason" value={p.fileForm.reason} />
              {b.file.name} <button type="submit" class="link">{t(l, 'adm.app.download')}</button>
            </form>
          )
          : t(l, 'resume.no_file')}
      </dd>
    </dl>
  );
};

/** 내 지원서를 연 기록 (역할·시각만, 최근 순). 이름·이메일·사유는 보이지 않는다. */
export const ViewHistory = ({ locale, views }: { locale: Locale; views: Array<{ actor_role: string; at: number }> }) => (
  <div class="box">
    <h2>{t(locale, 'app.views.title')}</h2>
    <p class="hint">{t(locale, 'app.views.note')}</p>
    {views.length === 0 ? <p class="muted">{t(locale, 'app.views.empty')}</p> : (
      <table>
        <thead><tr><th>{t(locale, 'app.views.at')}</th><th>{t(locale, 'app.views.who')}</th></tr></thead>
        <tbody>
          {views.map((v) => (
            <tr><td>{fmtDateTime(v.at)}</td><td>{t(locale, `app.views.role.${v.actor_role === 'admin' ? 'admin' : v.actor_role === 'headhunter' ? 'headhunter' : 'company'}`)}</td></tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

export const ApplicationPage = (p: {
  locale: Locale; row: ApplicationRow; job: ApplyJob; snapshot: SnapshotState; canWithdraw: boolean; ok?: string; error?: string;
  views?: Array<{ actor_role: string; at: number }>;
}) => {
  const l = p.locale;
  const r = p.row;
  const s = p.snapshot;
  return (
    <section class="wide">
      <Crumbs locale={l} />
      <h1>{t(l, 'app.page.title')}</h1>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <div class="box">
        <JobHead locale={l} job={p.job} />
        <dl class="kv">
          <dt>{t(l, 'app.status')}</dt><dd><b>{statusText(l, r.status)}</b></dd>
          <dt>{t(l, 'app.applied_at')}</dt><dd>{fmtDate(r.created_at)}</dd>
          {r.status_changed_at !== r.created_at && (<><dt>{t(l, 'app.status_at')}</dt><dd>{fmtDate(r.status_changed_at)}</dd></>)}
          {r.status !== 'withdrawn' && (
            <>
              <dt>{t(l, 'app.consent')}</dt>
              <dd>{r.cross_border_consent_at !== null
                ? t(l, 'app.consent.yes').replace('{date}', fmtDate(r.cross_border_consent_at))
                : t(l, 'app.consent.no')}</dd>
            </>
          )}
        </dl>
      </div>

      {s.kind === 'deleted' && <div class="box"><p>{t(l, 'app.deleted')}</p></div>}
      {s.kind === 'unavailable' && <div class="box"><p class="muted">{t(l, 'app.unavailable')}</p></div>}
      {s.kind === 'ok' && (
        <div class="box">
          <h2>{t(l, 'app.content')}</h2>
          <p class="hint">{t(l, 'app.content_note')}</p>
          <SnapshotFields locale={l} body={s.body} fileHref={s.body.file && r.file_r2_key ? `/my/applications/${r.id}/file` : null} />
        </div>
      )}

      {r.status !== 'withdrawn' && p.views && <ViewHistory locale={l} views={p.views} />}

      {p.canWithdraw && (
        <div class="actions">
          <a href={`/my/applications/${r.id}/withdraw`} class="danger">{t(l, 'app.withdraw')}</a>
        </div>
      )}
      <p><a href="/my/applications">{t(l, 'app.back')}</a></p>
    </section>
  );
};

// ── 지원 취소 확인 (자바스크립트 없이 확인 화면 → POST)

export const WithdrawConfirm = ({ locale, id, job }: { locale: Locale; id: string; job: ApplyJob }) => (
  <section class="card">
    <h1>{t(locale, 'app.withdraw.title')}</h1>
    <JobHead locale={locale} job={job} />
    <ul>
      <li>{t(locale, 'app.withdraw.delete')}</li>
      <li>{t(locale, 'app.withdraw.company')}</li>
      <li>{t(locale, 'app.withdraw.no_reapply')}</li>
    </ul>
    <form method="post" action={`/my/applications/${id}/withdraw`}>
      <div class="actions">
        <button type="submit" class="secondary">{t(locale, 'app.withdraw.submit')}</button>
        <a href={`/my/applications/${id}`}>{t(locale, 'common.cancel')}</a>
      </div>
    </form>
  </section>
);
