// 기업 → 지원자 메일 화면 (T-09b): 면접 요청(쓰기·미리 보기·결과), 불합격 통보(확인). 모든 값은 JSX 로 출력한다 (자동 이스케이프).
//
// 원칙 (CLAUDE.md 규칙 1·5·8, docs/ARCHITECTURE.md 12장)
// - 이 화면들에는 지원자의 개인정보가 없다: 공고 제목·지원 순서 번호·지원일·상태뿐. 지원서 내용은 /biz/applications/:id 에서만 보인다.
// - 메시지 글은 기업 담당자가 쓴다. 사이트가 쓴 예문·추천 답장·평가 문구는 없다. 불합격 통보는 정해진 글(locales mail.reject.*)만.
// - 메시지 글은 POST 본문(숨은 칸)으로만 오간다. 주소(쿼리)에 넣지 않는다.
import type { Locale } from '../env';
import { INTERVIEW_MAIL_MAX } from '../lib/applicant-mail';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import { MESSAGE_MAX } from '../lib/localize/message';

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const aplStatus = (l: Locale, s: string) => t(l, `apl.status.${s}`);
export const tf = (l: Locale, key: string, v: Record<string, string | number>) => fill(t(l, key), v);

/** 면접 요청을 보낼 수 있는 상태 (rules.nextStatus(…, 'interview_mail') 가 interview 가 되는 상태). 불합격 통보도 같다. */
export const MAIL_OPEN_STATUSES = ['submitted', 'viewed', 'reviewing', 'interview'] as const;
export const isMailOpen = (s: string) => (MAIL_OPEN_STATUSES as readonly string[]).includes(s);

/** 개인정보 없는 머리말: 공고 제목·지원 순서 번호·지원일·상태. */
export interface MailHeadInfo { jobId: string; jobTitle: string | null; no: number | null; createdAt: number; status: string }

const Crumbs = ({ locale, jobId }: { locale: Locale; jobId: string }) => (
  <p class="crumbs">
    <a href="/biz">{t(locale, 'biz.title')}</a> · <a href="/biz/jobs">{t(locale, 'job.list.title')}</a> · <a href={`/biz/jobs/${jobId}/applicants`}>{t(locale, 'apl.list.title')}</a>
  </p>
);

const Head = ({ locale, h }: { locale: Locale; h: MailHeadInfo }) => (
  <div class="box">
    <dl class="kv">
      <dt>{t(locale, 'apply.to.job')}</dt><dd lang="ko">{h.jobTitle || t(locale, 'job.untitled')}</dd>
      <dt>{t(locale, 'aplm.applicant')}</dt><dd>{h.no !== null ? tf(locale, 'aplm.applicant_no', { n: h.no }) : '-'}</dd>
      <dt>{t(locale, 'app.applied_at')}</dt><dd>{fmtDate(h.createdAt)}</dd>
      <dt>{t(locale, 'app.status')}</dt><dd>{aplStatus(locale, h.status)}</dd>
    </dl>
  </div>
);

// ── 면접 요청: 쓰기 칸 (지원서 화면 안, 또는 따로 쓰기 화면)

export interface InterviewFormProps {
  locale: Locale;
  appId: string;
  sent: number;
  replyTo: string;
  text?: string;
  error?: string;
}

export const InterviewForm = (p: InterviewFormProps) => {
  const l = p.locale;
  const remaining = Math.max(0, INTERVIEW_MAIL_MAX - p.sent);
  return (
    <div class="box">
      <h2>{t(l, 'aplm.iv.title')}</h2>
      {p.error && <p class="error">{p.error}</p>}
      <p>{t(l, 'aplm.iv.lead')}</p>
      <form method="post" action={`/biz/applications/${p.appId}/interview/preview`}>
        <label>
          {t(l, 'aplm.iv.message')} *
          <textarea name="message" rows={10} maxlength={MESSAGE_MAX} required>{p.text ?? ''}</textarea>
          <span class="hint">{tf(l, 'aplm.iv.hint', { max: MESSAGE_MAX })}</span>
        </label>
        <p class="hint">{tf(l, 'aplm.iv.reply_to', { email: p.replyTo })}</p>
        <p class="hint">
          {p.sent > 0 && <>{tf(l, 'aplm.iv.sent_count', { n: p.sent })} · </>}
          {tf(l, 'aplm.iv.remaining', { n: remaining, max: INTERVIEW_MAIL_MAX })}
        </p>
        <div class="actions"><button type="submit">{t(l, 'aplm.iv.preview')}</button></div>
      </form>
    </div>
  );
};

/** 지원서 화면 아래의 메일 칸: 보낼 수 있으면 면접 요청 폼, 횟수를 다 썼으면 안내, 그리고 불합격 통보 입구. 끝난 지원이면 아무것도 없다. */
export const ApplicationMailSection = (p: { locale: Locale; appId: string; jobId: string; status: string; sent: number; replyTo: string }) => {
  const l = p.locale;
  if (!isMailOpen(p.status)) return <></>;
  return (
    <>
      {p.sent < INTERVIEW_MAIL_MAX
        ? <InterviewForm locale={l} appId={p.appId} sent={p.sent} replyTo={p.replyTo} />
        : <div class="box"><h2>{t(l, 'aplm.iv.title')}</h2><p class="muted">{tf(l, 'aplm.iv.limit_reached', { max: INTERVIEW_MAIL_MAX })}</p></div>}
      <form method="post" action={`/biz/jobs/${p.jobId}/applicants/reject/confirm`} class="box">
        <h2>{t(l, 'aplm.rj.entry_title')}</h2>
        <p class="hint">{t(l, 'aplm.rj.entry_hint')}</p>
        <input type="hidden" name="id" value={p.appId} />
        <div class="actions"><button type="submit" class="plain">{t(l, 'aplm.rj.entry')}</button></div>
      </form>
    </>
  );
};

/** 따로 쓰기 화면 (미리 보기에서 "고치기", 입력 오류). 개인정보 없음. */
export const InterviewCompose = (p: { locale: Locale; head: MailHeadInfo; appId: string; sent: number; replyTo: string; text: string; error?: string }) => (
  <section class="wide">
    <Crumbs locale={p.locale} jobId={p.head.jobId} />
    <h1>{t(p.locale, 'aplm.iv.title')}</h1>
    <Head locale={p.locale} h={p.head} />
    <InterviewForm locale={p.locale} appId={p.appId} sent={p.sent} replyTo={p.replyTo} text={p.text} error={p.error} />
    <p><a href={`/biz/jobs/${p.head.jobId}/applicants`}>{t(p.locale, 'apl.back_list')}</a></p>
  </section>
);

// ── 면접 요청: 미리 보기

export interface InterviewPreviewProps {
  locale: Locale;
  head: MailHeadInfo;
  appId: string;
  original: string;
  /** null 이면 번역 없음(엔진 없음·실패·원문과 같음) → 원문만 보낸다. */
  translation: string | null;
  /** 번역이 없는 이유: 'failed' 만들지 못함, 'same' 원문이 이미 한국어. */
  noTranslation?: 'failed' | 'same';
  /** 오늘 자동 번역 한도에 걸려 번역하지 않았을 때의 안내 (T-05c). 있으면 noTranslation 문구 대신 보인다. 보내기는 그대로 된다. */
  limitNote?: string;
  onlyOriginal?: boolean;
  replyTo: string;
  sent: number;
  error?: string;
}

export const InterviewPreview = (p: InterviewPreviewProps) => {
  const l = p.locale;
  const id = p.appId;
  return (
    <section class="wide">
      <Crumbs locale={l} jobId={p.head.jobId} />
      <h1>{t(l, 'aplm.pv.title')}</h1>
      <Head locale={l} h={p.head} />
      {p.error && <p class="error">{p.error}</p>}
      <form method="post" action={`/biz/applications/${id}/interview/send`} class="box">
        {p.translation !== null ? (
          <>
            <div class="grid2">
              <div><h2>{t(l, 'aplm.pv.original')}</h2><div class="quote pre">{p.original}</div></div>
              <div><h2>{t(l, 'aplm.pv.translation')}</h2><div class="quote pre" lang="ko">{p.translation}</div></div>
            </div>
            <p class="warn">{t(l, 'aplm.pv.both')}</p>
            <label class="check"><input type="checkbox" name="only_original" value="1" checked={p.onlyOriginal ?? false} />{t(l, 'aplm.pv.only_original')}</label>
            <input type="hidden" name="translation" value={p.translation} />
          </>
        ) : (
          <>
            <h2>{t(l, 'aplm.pv.original')}</h2>
            <div class="quote pre">{p.original}</div>
            <p class="warn">{p.limitNote ?? t(l, p.noTranslation === 'same' ? 'aplm.pv.same' : 'aplm.pv.no_translation')}</p>
          </>
        )}
        <input type="hidden" name="message" value={p.original} />
        <p class="hint">{t(l, 'aplm.pv.mail_lang')}</p>
        <p class="hint">{tf(l, 'aplm.iv.reply_to', { email: p.replyTo })}</p>
        <p class="hint">{tf(l, 'aplm.iv.remaining', { n: Math.max(0, INTERVIEW_MAIL_MAX - p.sent), max: INTERVIEW_MAIL_MAX })}</p>
        <div class="actions">
          <button type="submit">{t(l, 'aplm.pv.send')}</button>
          <button type="submit" class="plain" formaction={`/biz/applications/${id}/interview/compose`}>{t(l, 'aplm.pv.edit')}</button>
        </div>
      </form>
    </section>
  );
};

/** 보내기 결과 (보내지 못함·기록되지 않음). 성공은 지원자 목록으로 리다이렉트한다. */
export const MailResultPage = (p: { locale: Locale; jobId: string; text: string; ok?: boolean }) => (
  <section class="card">
    <h1>{t(p.locale, 'aplm.res.title')}</h1>
    <p class={p.ok ? 'ok' : 'error'}>{p.text}</p>
    <p><a href={`/biz/jobs/${p.jobId}/applicants`}>{t(p.locale, 'apl.back_list')}</a></p>
  </section>
);

// ── 불합격 통보: 확인

export interface RejectConfirmProps {
  locale: Locale;
  job: { id: string; title_ko: string | null; title_zh: string | null };
  ids: string[];
  /** 고른 것 중 끝났거나 보낼 수 없어 뺀 수. */
  skipped: number;
  /** 실제로 보낼 정해진 글 (lib/applicant-mail.rejectMail, 한국어). */
  mail: { subject: string; text: string };
  /** 중국어 화면에서만: 같은 문구 키의 중국어판 (보내지 않음). */
  reference: { subject: string; text: string } | null;
  replyTo: string;
}

export const RejectConfirm = (p: RejectConfirmProps) => {
  const l = p.locale;
  return (
    <section class="wide">
      <Crumbs locale={l} jobId={p.job.id} />
      <h1>{t(l, 'aplm.rj.title')}</h1>
      <p class="sub muted">{p.job.title_zh || p.job.title_ko || t(l, 'job.untitled')}</p>
      <div class="box">
        <p><b>{tf(l, 'aplm.rj.count', { n: p.ids.length })}</b></p>
        {p.skipped > 0 && <p class="hint">{tf(l, 'aplm.rj.skipped', { n: p.skipped })}</p>}
        <div class="warn">
          <p>{t(l, 'aplm.rj.warn_undo')}</p>
          <p>{t(l, 'aplm.rj.warn_status')}</p>
          <p>{tf(l, 'aplm.rj.warn_reply', { email: p.replyTo })}</p>
        </div>
        <p class="hint">{t(l, 'aplm.rj.fixed')}</p>
      </div>
      <div class="box">
        <h2>{t(l, 'aplm.rj.text')}</h2>
        <dl class="kv"><dt>{t(l, 'aplm.rj.subject')}</dt><dd lang="ko">{p.mail.subject}</dd></dl>
        <div class="quote pre" lang="ko">{p.mail.text}</div>
        {p.reference && (
          <div class="spaced">
            <h2>{t(l, 'aplm.rj.text_ref')}</h2>
            <dl class="kv"><dt>{t(l, 'aplm.rj.subject')}</dt><dd>{p.reference.subject}</dd></dl>
            <div class="quote pre">{p.reference.text}</div>
          </div>
        )}
      </div>
      <form method="post" action={`/biz/jobs/${p.job.id}/applicants/reject/send`} class="box">
        {p.ids.map((id) => <input type="hidden" name="id" value={id} />)}
        <div class="actions">
          <button type="submit">{t(l, 'aplm.rj.send')}</button>
          <a href={`/biz/jobs/${p.job.id}/applicants`}>{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};

