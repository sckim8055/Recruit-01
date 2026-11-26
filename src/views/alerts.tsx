// 조건 알림 화면 (T-10): /jobs 의 "이 조건으로 새 공고 알림 받기" 칸, 구직자 /my/alerts, 메일의 해지 링크 /alerts/u/:token.
// 모든 값은 JSX 로 출력한다 (자동 이스케이프). 항목 이름은 관리자가 입력한 글이므로 더욱 그렇다.
// 화면에 "추천·맞춤" 같은 말을 쓰지 않는다 — 구직자가 고른 조건의 새 공고를 게재 순서대로 보낼 뿐이다 (CLAUDE.md 규칙 1).
import type { Locale } from '../env';
import { t } from '../lib/i18n';
import { ALERT_FREQUENCIES, ALERT_MAX_PER_USER, filterSummaryText, type AlertFrequency, type SummaryItem } from '../lib/alerts';
import { FILTER_KEYS, jobsHref, type JobFilter } from '../lib/public-jobs';
import type { AlertRow } from '../db/alerts';
import { Flash } from './company';

const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);
const KST = 9 * 3600;
const kstDateTime = (ts: number): string => new Date((ts + KST) * 1000).toISOString().slice(0, 16).replace('T', ' ');

const Crumbs = ({ locale }: { locale: Locale }) => <p class="crumbs"><a href="/my">{t(locale, 'nav.my')}</a></p>;

const OptIn = ({ locale }: { locale: Locale }) => (
  <>
    <label class="check"><input type="checkbox" name="optin" value="1" required />{t(locale, 'alert.optin')}</label>
    <p class="hint">{t(locale, 'alert.optin_hint')}</p>
  </>
);

// ── /jobs 의 만들기 칸 (로그인한 구직자 + 조건이 하나 이상일 때만 그린다. 비로그인 캐시 화면에는 들어가지 않는다)

export const JobsAlertForm = ({ locale, filter }: { locale: Locale; filter: JobFilter }) => (
  <form method="post" action="/my/alerts" class="box">
    <h2>{t(locale, 'alert.create.title')}</h2>
    <p class="hint">{t(locale, 'alert.create.lead')} {t(locale, 'alert.not_recommend')}</p>
    {FILTER_KEYS.filter((k) => filter[k] !== undefined).map((k) => <input type="hidden" name={k} value={filter[k]} />)}
    <fieldset>
      <legend>{t(locale, 'alert.frequency')}</legend>
      {ALERT_FREQUENCIES.map((f, i) => (
        <label class="check"><input type="radio" name="frequency" value={f} checked={i === 0} />{t(locale, `alert.freq.${f}_note`)}</label>
      ))}
    </fieldset>
    <OptIn locale={locale} />
    <div class="actions">
      <button type="submit" class="plain">{t(locale, 'alert.create.submit')}</button>
      <a href="/my/alerts">{t(locale, 'alert.create.manage')}</a>
    </div>
  </form>
);

// ── /my/alerts

export interface AlertListItem {
  row: AlertRow;
  items: SummaryItem[];         // 저장된 조건 (지금 이름, 사용 종료·숨김 표시)
  effective: JobFilter;         // 지금 실제로 쓰는 조건
  effectiveEmpty: boolean;
}

export const AlertList = (p: {
  locale: Locale; alerts: AlertListItem[]; ok?: string; error?: string; errorVars?: Record<string, string | number>;
  /** 사이트 전체 알림 메일 발송이 멈춘 상태 (T-17). 목록·관리는 그대로 된다. */
  paused?: boolean;
}) => {
  const l = p.locale;
  return (
    <section class="wide">
      <Crumbs locale={l} />
      <h1>{t(l, 'alert.title')}</h1>
      <p class="sub muted">{t(l, 'alert.lead')}</p>
      <Flash locale={l} ok={p.ok} />
      {p.paused && <p class="warn">{t(l, 'alert.paused_site')} {t(l, 'alert.paused_site_more')}</p>}
      {p.error && <p class="error">{fill(t(l, p.error), p.errorVars ?? {})}</p>}
      {p.alerts.length === 0 ? (
        <div class="box">
          <p>{t(l, 'alert.empty')}</p>
          <p><a href="/jobs">{t(l, 'alert.empty_link')}</a></p>
        </div>
      ) : p.alerts.map(({ row, items, effective, effectiveEmpty }) => {
        const ignored = items.filter((i) => i.ignored);
        return (
          <div class="box">
            <p><b>{filterSummaryText(items, l, true)}</b></p>
            <dl class="kv">
              <dt>{t(l, 'alert.state')}</dt>
              <dd>
                {row.status === 'active'
                  ? <span class="badge s-verified">{t(l, 'alert.status.active')}</span>
                  : <><span class="badge">{t(l, 'alert.status.paused')}</span> <span class="muted">{t(l, `alert.paused.${row.paused_reason ?? 'user'}`)}</span></>}
              </dd>
              <dt>{t(l, 'alert.frequency')}</dt><dd>{t(l, `alert.freq.${row.frequency}_note`)}</dd>
              {row.status === 'active' && row.next_due_at > 0 && (<><dt>{t(l, 'alert.next')}</dt><dd>{kstDateTime(row.next_due_at)} {t(l, 'alert.kst')}</dd></>)}
              <dt>{t(l, 'alert.last')}</dt><dd>{row.last_sent_at ? `${kstDateTime(row.last_sent_at)} ${t(l, 'alert.kst')}` : t(l, 'alert.last.none')}</dd>
            </dl>
            {ignored.length > 0 && <p class="warn">{fill(t(l, 'alert.ignored'), { names: ignored.map((i) => i.name).join(', ') })}</p>}
            {effectiveEmpty && <p class="warn">{t(l, 'alert.no_filter')}</p>}
            {!effectiveEmpty && <p><a href={jobsHref(effective)}>{t(l, 'alert.view_jobs')}</a></p>}
            <form method="post" action={`/my/alerts/${row.id}/frequency`} class="grid2">
              <label>{t(l, 'alert.frequency')}
                <select name="frequency">
                  {ALERT_FREQUENCIES.map((f: AlertFrequency) => <option value={f} selected={row.frequency === f}>{t(l, `alert.freq.${f}_note`)}</option>)}
                </select>
              </label>
              <div class="actions"><button type="submit" class="plain">{t(l, 'alert.save_freq')}</button></div>
            </form>
            {row.status === 'active' ? (
              <div class="actions">
                <form method="post" action={`/my/alerts/${row.id}/pause`} class="inline"><button type="submit" class="plain">{t(l, 'alert.pause')}</button></form>
                <form method="post" action={`/my/alerts/${row.id}/delete`} class="inline"><button type="submit" class="secondary">{t(l, 'alert.delete')}</button></form>
              </div>
            ) : (
              <>
                <form method="post" action={`/my/alerts/${row.id}/resume`}>
                  <OptIn locale={l} />
                  <div class="actions"><button type="submit" class="plain">{t(l, 'alert.resume')}</button></div>
                </form>
                <div class="actions">
                  <form method="post" action={`/my/alerts/${row.id}/delete`} class="inline"><button type="submit" class="secondary">{t(l, 'alert.delete')}</button></form>
                </div>
              </>
            )}
          </div>
        );
      })}
      <div class="box">
        <p class="muted">{fill(t(l, 'alert.count'), { n: p.alerts.length, max: ALERT_MAX_PER_USER })}</p>
        <p class="hint">{t(l, 'alert.how')}</p>
        <p class="hint">{t(l, 'alert.not_recommend')}</p>
        <p class="hint">{t(l, 'alert.hidden_rule')}</p>
      </div>
    </section>
  );
};

/** 만들기 요청이 거절됐을 때 (/jobs 에서 온 POST). 조건을 고른 /jobs 화면으로 돌아가는 링크. */
export const AlertCreateProblem = ({ locale, error, vars, back }: { locale: Locale; error: string; vars?: Record<string, string | number>; back: string }) => (
  <section class="card">
    <h1>{t(locale, 'alert.create.title')}</h1>
    <p class="error">{fill(t(locale, error), vars ?? {})}</p>
    <div class="actions">
      <a href={back}>{t(locale, 'alert.back_jobs')}</a>
      <a href="/my/alerts">{t(locale, 'alert.create.manage')}</a>
    </div>
  </section>
);

// ── 해지 링크 (/alerts/u/:token) — 로그인하지 않는다. 조건 요약 말고는 보이지 않는다 (이메일·이름 없음)

export const UnsubConfirm = ({ locale, token, summary, active }: { locale: Locale; token: string; summary: string; active: boolean }) => (
  <section class="card">
    <h1>{t(locale, 'alert.unsub.title')}</h1>
    <p class="muted">{t(locale, 'alert.unsub.lead')}</p>
    <dl class="kv"><dt>{t(locale, 'alert.unsub.filter')}</dt><dd>{summary}</dd></dl>
    {active ? (
      <form method="post" action={`/alerts/u/${token}`}>
        <div class="actions"><button type="submit">{t(locale, 'alert.unsub.one')}</button></div>
      </form>
    ) : <p class="info">{t(locale, 'alert.unsub.already')}</p>}
    <form method="post" action={`/alerts/u/${token}/all`}>
      <div class="actions"><button type="submit" class="plain">{t(locale, 'alert.unsub.all')}</button></div>
    </form>
  </section>
);

export const UnsubDone = ({ locale, all }: { locale: Locale; all: number | null }) => (
  <section class="card">
    <h1>{t(locale, 'alert.unsub.title')}</h1>
    <p class="ok">{all === null ? t(locale, 'alert.unsub.done_one') : fill(t(locale, 'alert.unsub.done_all'), { n: all })}</p>
    <p class="hint">{t(locale, 'alert.unsub.again')}</p>
  </section>
);

export const UnsubInvalid = ({ locale }: { locale: Locale }) => (
  <section class="card">
    <h1>{t(locale, 'alert.unsub.title')}</h1>
    <p>{t(locale, 'alert.unsub.invalid')}</p>
    <p><a href="/my/alerts">{t(locale, 'alert.title')}</a></p>
  </section>
);
