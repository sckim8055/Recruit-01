// 지원자 관리 화면 (T-09a): 기업의 지원자 목록·지원서 열람, 관리자의 사유 입력 열람·열람 기록. 모든 값은 JSX 로 출력한다 (자동 이스케이프).
//
// 원칙 (CLAUDE.md 규칙 1·3·4, docs/ARCHITECTURE.md 12장)
// - 목록에는 개인정보가 없다 (번호·지원일·상태·첨부 여부뿐). 이름·연락처는 지원서를 열어야 보이고, 열면 기록이 남는다.
// - 정렬·점수·추천 표시·메모·내보내기·전달·상태 변경 버튼은 없다. 운영자는 지원자를 검토·추천·전달하지 않는다.
// - 지원서 내용은 lib/applicants.openApplication 이 돌려준 body 만 그린다 (SnapshotFields = 구직자 본인 화면과 같은 조각).
import type { Locale } from '../env';
import { ADMIN_REASON_MAX } from '../lib/applicants';
import { fmtDate, fmtDateTime } from '../lib/company';
import { t } from '../lib/i18n';
import type { ResumeBody } from '../lib/resume';
import type { AccessLogRow, ApplicantListRow, ApplicationWithJob } from '../db/applicants';
import { SnapshotFields } from './applications';
import { Flash } from './company';
import { ApplicationMailSection, isMailOpen, tf } from './applicant-mail';
import { REJECT_BATCH_MAX } from '../lib/applicant-mail';

const jobTitle = (l: Locale, title: string | null) => title || t(l, 'job.untitled');
/** 기업·관리자 쪽 상태 이름 (구직자 쪽 app.status.* 와 다르다: "열람함", "면접 요청함" 처럼 기업이 한 일로 적는다). */
export const aplStatus = (l: Locale, s: string) => t(l, `apl.status.${s}`);

const StatusBadge = ({ locale, status }: { locale: Locale; status: string }) => (
  <span class={status === 'submitted' ? 'badge s-verified' : 'badge'}>{aplStatus(locale, status)}</span>
);

const BizCrumbs = ({ locale, jobId }: { locale: Locale; jobId?: string }) => (
  <p class="crumbs">
    <a href="/biz">{t(locale, 'biz.title')}</a> · <a href="/biz/jobs">{t(locale, 'job.list.title')}</a>
    {jobId && <> · <a href={`/biz/jobs/${jobId}/applicants`}>{t(locale, 'apl.list.title')}</a></>}
  </p>
);

// ── 기업: 지원자 목록

export interface ApplicantListProps {
  locale: Locale;
  job: { id: string; title_ko: string | null; title_zh: string | null };
  rows: ApplicantListRow[];
  /** 이 담당자가 중국 본사 소속이면 true — 국외 이전 동의가 없는 지원서는 열 수 없다 (authz.canViewApplication). */
  hq: boolean;
  /** 지원별 면접 요청 메일 수 (T-09b, db/applicant-views.countInterviewMailsByJob). */
  interviewCounts?: Record<string, number>;
  /** 결과 표시 (이미 문구로 만든 글). */
  ok?: string[];
  error?: string;
}

export const ApplicantList = (p: ApplicantListProps) => {
  const l = p.locale;
  return (
    <section class="wide">
      <BizCrumbs locale={l} />
      <h1>{t(l, 'apl.list.title')}</h1>
      <p class="sub muted">{p.job.title_zh || jobTitle(l, p.job.title_ko)}{p.job.title_zh && p.job.title_ko && <> · <span lang="ko">{p.job.title_ko}</span></>}</p>
      <div class="box">
        <p>{t(l, 'apl.list.note')}</p>
        <p class="hint">{t(l, 'apl.list.order')}</p>
        {p.hq && <p class="hint">{t(l, 'apl.list.hq_note')}</p>}
      </div>
      {p.ok?.map((x) => <p class="ok">{x}</p>)}
      {p.error && <p class="error">{p.error}</p>}
      {p.rows.length === 0 ? <p class="muted">{t(l, 'apl.list.empty')}</p> : (
        <form method="post" action={`/biz/jobs/${p.job.id}/applicants/reject/confirm`} class="box">
          <table>
            <thead><tr>
              <th>{t(l, 'aplm.list.select')}</th>
              <th>{t(l, 'apl.no')}</th><th>{t(l, 'app.applied_at')}</th><th>{t(l, 'app.status')}</th><th>{t(l, 'resume.f.attachment')}</th><th></th>
            </tr></thead>
            <tbody>
              {p.rows.map((r, i) => {
                const withdrawn = r.status === 'withdrawn';
                const blocked = !withdrawn && p.hq && r.cross_border_consent_at === null;
                const ivCount = p.interviewCounts?.[r.id] ?? 0;
                return (
                  <tr>
                    <td>{!blocked && isMailOpen(r.status) && <input type="checkbox" name="id" value={r.id} aria-label={`${t(l, 'aplm.list.select')} ${i + 1}`} />}</td>
                    <td>{i + 1}</td>
                    <td>{fmtDate(r.created_at)}</td>
                    <td>
                      <StatusBadge locale={l} status={r.status} />
                      {ivCount > 0 && <span class="hint">{tf(l, 'aplm.list.iv_count', { n: ivCount })}</span>}
                    </td>
                    <td>{withdrawn ? '' : t(l, r.has_file === 1 ? 'common.yes' : 'apl.no_file')}</td>
                    <td>
                      {withdrawn ? <span class="muted">{t(l, 'apl.withdrawn_row')}</span>
                        : blocked ? <span class="muted">{t(l, 'apl.no_consent_row')}</span>
                        : <a href={`/biz/applications/${r.id}`}>{t(l, 'apl.open')}</a>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {p.rows.some((r) => isMailOpen(r.status) && !(p.hq && r.cross_border_consent_at === null)) && (
            <div class="spaced">
              <p class="hint">{tf(l, 'aplm.list.reject_hint', { max: REJECT_BATCH_MAX })}</p>
              <div class="actions"><button type="submit" class="plain">{t(l, 'aplm.list.reject_btn')}</button></div>
            </div>
          )}
        </form>
      )}
      <p><a href={`/biz/jobs/${p.job.id}`}>{t(l, 'apl.back_job')}</a></p>
    </section>
  );
};

// ── 기업: 지원서 한 건

export const CompanyApplicationPage = (p: {
  locale: Locale; app: ApplicationWithJob; status: string; body: ResumeBody;
  /** T-09b: 이 지원에 보낸 면접 요청 수와 답장 주소(로그인한 담당자 본인의 이메일). */
  mail?: { sent: number; replyTo: string };
}) => {
  const l = p.locale;
  const a = p.app;
  return (
    <section class="wide">
      <BizCrumbs locale={l} jobId={a.job_id} />
      <h1>{t(l, 'apl.page.title')}</h1>
      <div class="box">
        <dl class="kv">
          <dt>{t(l, 'apply.to.job')}</dt><dd lang="ko">{jobTitle(l, a.job_title_ko)}</dd>
          <dt>{t(l, 'app.applied_at')}</dt><dd>{fmtDate(a.created_at)}</dd>
          <dt>{t(l, 'app.status')}</dt><dd><b>{aplStatus(l, p.status)}</b></dd>
          <dt>{t(l, 'apl.consent')}</dt>
          <dd>{a.cross_border_consent_at !== null ? t(l, 'apl.consent.yes') : t(l, 'apl.consent.no')}</dd>
        </dl>
        <p class="hint">{t(l, 'apl.page.logged')}</p>
      </div>
      <div class="box">
        <h2>{t(l, 'apl.page.content')}</h2>
        <p class="hint">{t(l, 'apl.page.content_note')}</p>
        <SnapshotFields locale={l} body={p.body} fileHref={a.file_r2_key ? `/biz/applications/${a.id}/file` : null} />
      </div>
      {p.mail && <ApplicationMailSection locale={l} appId={a.id} jobId={a.job_id} status={p.status} sent={p.mail.sent} replyTo={p.mail.replyTo} />}
      <p><a href={`/biz/jobs/${a.job_id}/applicants`}>{t(l, 'apl.back_list')}</a></p>
    </section>
  );
};

/** 열 수 없는 지원서: 취소됨 / 국외 이전 동의 없음(본사 담당자) / 열 수 없음. 이 기업의 지원서일 때만 쓴다 (남의 것은 404). */
export const CompanyApplicationNotice = (p: { locale: Locale; jobId: string; kind: 'withdrawn' | 'no_consent' | 'unreadable' }) => (
  <section class="card">
    <h1>{t(p.locale, `apl.notice.${p.kind}.title`)}</h1>
    <p>{t(p.locale, `apl.notice.${p.kind}`)}</p>
    <p><a href={`/biz/jobs/${p.jobId}/applicants`}>{t(p.locale, 'apl.back_list')}</a></p>
  </section>
);

// ── 관리자: 지원서 (개인정보 없는 정보 + 사유 입력)

const AdminCrumbs = ({ locale }: { locale: Locale }) => (
  <p class="crumbs"><a href="/admin">{t(locale, 'admin.title')}</a> · <a href="/admin/access-log">{t(locale, 'adm.log.title')}</a></p>
);

const AdminMeta = ({ locale, app }: { locale: Locale; app: ApplicationWithJob }) => (
  <div class="box">
    <dl class="kv">
      <dt>{t(locale, 'adm.app.id')}</dt><dd>{app.id}</dd>
      <dt>{t(locale, 'apply.to.job')}</dt><dd lang="ko">{jobTitle(locale, app.job_title_ko)}</dd>
      <dt>{t(locale, 'adm.app.company')}</dt><dd><a href={`/admin/companies/${app.company_id}`}>{app.company_id}</a></dd>
      <dt>{t(locale, 'app.applied_at')}</dt><dd>{fmtDate(app.created_at)}</dd>
      <dt>{t(locale, 'app.status')}</dt><dd>{aplStatus(locale, app.status)}</dd>
      <dt>{t(locale, 'apl.consent')}</dt><dd>{t(locale, app.cross_border_consent_at !== null ? 'common.yes' : 'adm.app.no')}</dd>
      <dt>{t(locale, 'resume.f.attachment')}</dt><dd>{t(locale, app.file_r2_key ? 'common.yes' : 'adm.app.no')}</dd>
    </dl>
  </div>
);

export interface AdminApplicationProps {
  locale: Locale;
  app: ApplicationWithJob;
  /** 'withdrawn' | 'unreadable' 이면 사유 폼 대신 안내만. */
  notice?: 'withdrawn' | 'unreadable';
  error?: string;
  reason?: string;
}

export const AdminApplicationPage = (p: AdminApplicationProps) => {
  const l = p.locale;
  const closed = p.notice ?? (p.app.status === 'withdrawn' ? 'withdrawn' : undefined);
  return (
    <section class="wide">
      <AdminCrumbs locale={l} />
      <h1>{t(l, 'adm.app.title')}</h1>
      <Flash locale={l} error={p.error} />
      <AdminMeta locale={l} app={p.app} />
      {closed ? <div class="box"><p>{t(l, `adm.app.notice.${closed}`)}</p></div> : (
        <form method="post" action={`/admin/applications/${p.app.id}/open`} class="box">
          <label>
            {t(l, 'adm.app.reason')} *
            <input type="text" name="reason" required maxlength={ADMIN_REASON_MAX} value={p.reason ?? ''} />
            <span class="hint">{t(l, 'adm.app.reason_hint')}</span>
          </label>
          <div class="actions"><button type="submit">{t(l, 'adm.app.open')}</button></div>
        </form>
      )}
    </section>
  );
};

/** POST 응답으로만 그린다 (GET 으로 다시 열 수 있는 주소에 내용이 없게). 수정·전달·일괄 내려받기 없음. */
export const AdminApplicationContent = (p: { locale: Locale; app: ApplicationWithJob; body: ResumeBody; reason: string }) => {
  const l = p.locale;
  return (
    <section class="wide">
      <AdminCrumbs locale={l} />
      <h1>{t(l, 'adm.app.title')}</h1>
      <AdminMeta locale={l} app={p.app} />
      <div class="box">
        <h2>{t(l, 'apl.page.content')}</h2>
        <p class="hint">{t(l, 'adm.app.logged').replace('{reason}', p.reason)}</p>
        <SnapshotFields locale={l} body={p.body} fileForm={p.app.file_r2_key ? { action: `/admin/applications/${p.app.id}/file`, reason: p.reason } : null} />
      </div>
      <p><a href={`/admin/applications/${p.app.id}`}>{t(l, 'adm.app.close')}</a></p>
    </section>
  );
};

// ── 관리자: 열람 기록

export const ACCESS_LOG_TYPES = ['application', 'resume', 'verification_doc'] as const;
export type AccessLogType = (typeof ACCESS_LOG_TYPES)[number];

export const AccessLogPage = (p: { locale: Locale; rows: AccessLogRow[]; type: AccessLogType | null; next: number | null; first: boolean }) => {
  const l = p.locale;
  const typeQ = p.type ? `type=${p.type}` : '';
  const href = (before: number | null) => {
    const q = [typeQ, before !== null ? `before=${before}` : ''].filter(Boolean).join('&');
    return `/admin/access-log${q ? `?${q}` : ''}`;
  };
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a></p>
      <h1>{t(l, 'adm.log.title')}</h1>
      <p class="sub muted">{t(l, 'adm.log.lead')}</p>
      <form method="get" action="/admin/access-log" class="box grid4">
        <label>
          {t(l, 'adm.log.target')}
          <select name="type">
            <option value="">{t(l, 'adm.log.type.all')}</option>
            {ACCESS_LOG_TYPES.map((x) => <option value={x} selected={p.type === x}>{t(l, `adm.log.type.${x}`)}</option>)}
          </select>
        </label>
        <div class="actions"><button type="submit" class="plain">{t(l, 'adm.log.filter')}</button></div>
      </form>
      {p.rows.length === 0 ? <p class="muted">{t(l, 'adm.log.empty')}</p> : (
        <div class="box">
          <table>
            <thead><tr>
              <th>{t(l, 'adm.log.at')}</th><th>{t(l, 'adm.log.actor')}</th><th>{t(l, 'adm.log.target')}</th><th>{t(l, 'adm.log.reason')}</th>
            </tr></thead>
            <tbody>
              {p.rows.map((r) => (
                <tr>
                  <td>{fmtDateTime(r.at)}</td>
                  <td>{r.actor_email ?? r.actor_id} <span class="muted">{t(l, `adm.log.role.${r.actor_role}`)}</span></td>
                  <td>
                    {t(l, `adm.log.type.${r.target_type}`)}<br />
                    {r.target_type === 'application'
                      ? <a href={`/admin/applications/${r.target_id}`}>{r.target_id}</a>
                      : <span class="muted">{r.target_id}</span>}
                  </td>
                  <td>{r.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="pager">
        <span>{!p.first && <a href={href(null)}>{t(l, 'adm.log.newest')}</a>}</span>
        <span>{p.next !== null && <a href={href(p.next)}>{t(l, 'adm.log.older')}</a>}</span>
      </div>
    </section>
  );
};
