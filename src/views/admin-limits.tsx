// 사용량 한도·조건 알림 켜기/끄기 (T-17). 관리자 사이트 설정(/admin/settings)의 두 상자, 확인 화면, 시스템 점검(/admin/system)의 표.
// 저장은 두 단계다(자바스크립트 없음): 폼 → 확인 화면(지금 → 바꾼 뒤, 결과, "확인했습니다") → 저장. 모든 값은 JSX 로 출력한다.
import type { Locale } from '../env';
import { fmtDateTime } from '../lib/company';
import { t } from '../lib/i18n';
import {
  alertsPaused, limitSpecOf, mailPlanWarning, LIMIT_KEYS, LIMIT_SPEC, FREE_PLAN_MAIL_WARN,
  type EffectiveLimits, type LimitFieldError, type LimitKey, type LimitsForm, type LimitsLogEntry, type LimitSource,
} from '../lib/limits';
import { SHARED_SLOTS } from '../lib/maintenance';
import { Flash } from './company';

/** 조건 알림을 보내는 예약 실행 수 (하루, lib/maintenance SHARED_SLOTS). */
const ALERT_RUNS_PER_DAY = Object.keys(SHARED_SLOTS).length;

const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);

/** 값 → 화면 글 ("500회", "20개", 처리 수 "8건"). */
export const limitValueText = (l: Locale, k: LimitKey, n: number): string =>
  fill(t(l, k === 'DRAFT_JOBS_PER_COMPANY' ? 'adm.lim.unit.count' : k === 'ALERT_SEND_PER_RUN' ? 'adm.lim.unit.run' : 'adm.lim.unit.day'), { n });

const sourceText = (l: Locale, s: LimitSource) => t(l, `adm.lim.src.${s}`);

/** 알림이 멈춘 이유 (멈추지 않았으면 null). */
export function pausedReason(e: Pick<EffectiveLimits, 'values' | 'alertsEnabled'>): 'off' | 'mail_zero' | 'run_zero' | null {
  if (!e.alertsEnabled) return 'off';
  if (e.values.ALERT_MAIL_SITE_DAY === 0) return 'mail_zero';
  if (e.values.ALERT_SEND_PER_RUN === 0) return 'run_zero';
  return null;
}

export interface LimitsMeta { by: string | null; at: number }

const LastChange = ({ locale, meta }: { locale: Locale; meta: LimitsMeta | null }) => (
  <p class="muted">
    {meta ? fill(t(locale, 'adm.lim.last'), { who: meta.by ?? t(locale, 'adm.ret.last_unknown'), at: fmtDateTime(meta.at) }) : t(locale, 'adm.lim.never')}
  </p>
);

const PlanWarning = ({ locale, e }: { locale: Locale; e: EffectiveLimits }) =>
  mailPlanWarning(e.values)
    ? <p class="warn">{fill(t(locale, 'adm.lim.plan_warn'), { mail: e.values.MAIL_SITE_DAY, alert: e.values.ALERT_MAIL_SITE_DAY, sum: e.values.MAIL_SITE_DAY + e.values.ALERT_MAIL_SITE_DAY, max: FREE_PLAN_MAIL_WARN })}</p>
    : null;

/** 지금 값의 출처 한 줄: "지금: 관리자 설정 (설정 파일 값 60 · 기본값 1000)". */
const SourceLine = ({ locale, e, k }: { locale: Locale; e: EffectiveLimits; k: LimitKey }) => {
  const l = locale;
  const env = e.envValues[k];
  const parts = [
    ...(e.source[k] !== 'env' && env !== undefined ? [fill(t(l, 'adm.lim.env_value'), { v: limitValueText(l, k, env) })] : []),
    ...(e.source[k] !== 'default' ? [fill(t(l, 'adm.lim.default_value'), { v: limitValueText(l, k, limitSpecOf(k).default) })] : []),
  ];
  return (
    <span class="hint">
      {t(l, 'adm.lim.now')} <span class="badge">{sourceText(l, e.source[k])}</span>{parts.length > 0 && ` (${parts.join(' · ')})`}
    </span>
  );
};

const errText = (l: Locale, k: LimitKey, e: LimitFieldError) => {
  const s = limitSpecOf(k);
  return fill(t(l, `adm.lim.err.${e}`), { min: s.min, max: s.max, site: s.site ? t(l, `adm.lim.f.${s.site}`) : '' });
};

export const LimitsBox = (p: {
  locale: Locale; effective: EffectiveLimits; form: LimitsForm; errors?: Partial<Record<LimitKey, LimitFieldError>>;
  meta: LimitsMeta | null; log: LimitsLogEntry[]; ok?: string; error?: string;
}) => {
  const l = p.locale;
  const errors = p.errors ?? {};
  return (
    <div class="box" id="limits">
      <h2>{t(l, 'adm.lim.title')}</h2>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <p class="muted">{t(l, 'adm.lim.lead')}</p>
      <ul class="hint">
        <li>{t(l, 'adm.lim.note.order')}</li>
        <li>{t(l, 'adm.lim.note.day')}</li>
        <li>{t(l, 'adm.lim.note.zero')}</li>
      </ul>
      <LastChange locale={l} meta={p.meta} />
      <PlanWarning locale={l} e={p.effective} />
      {Object.keys(errors).length > 0 && <p class="error">{t(l, 'adm.lim.err.form')}</p>}
      <form method="post" action="/admin/settings/limits">
        {LIMIT_SPEC.map((s) => (
          <label>
            {t(l, `adm.lim.f.${s.key}`)}
            <input type="number" name={s.key} value={p.form[s.key]} min={s.min} max={s.max} step={1} required inputmode="numeric" />
            <span class="hint">{fill(t(l, 'adm.lim.range'), { min: s.min, max: s.max })} {t(l, `adm.lim.why.${s.key}`)}</span>
            <SourceLine locale={l} e={p.effective} k={s.key} />
            {errors[s.key] && <span class="error">{errText(l, s.key, errors[s.key]!)}</span>}
          </label>
        ))}
        <p class="hint">{t(l, 'adm.lim.plan_note')}</p>
        <div class="actions">
          <button type="submit" name="mode" value="save">{t(l, 'adm.lim.next')}</button>
          <button type="submit" name="mode" value="reset" class="plain" formnovalidate>{t(l, 'adm.lim.reset')}</button>
        </div>
      </form>
      {p.log.length > 0 && (
        <details class="spaced">
          <summary>{t(l, 'adm.lim.log.title')}</summary>
          <ul class="rows">
            {[...p.log].reverse().slice(0, 5).map((e) => (
              <li>
                <span class="muted">{fmtDateTime(e.at)}</span>
                <span>
                  {e.reset && `${t(l, 'adm.lim.log.reset')} `}
                  {e.changes.map((c) => c.key === 'alerts_enabled'
                    ? `${t(l, 'adm.lim.al.short')} ${t(l, c.from ? 'adm.lim.al.on' : 'adm.lim.al.off')} → ${t(l, c.to ? 'adm.lim.al.on' : 'adm.lim.al.off')}`
                    : `${t(l, `adm.lim.f.${c.key}`)} ${limitValueText(l, c.key, c.from)} → ${limitValueText(l, c.key, c.to)}`).join(', ') || t(l, 'adm.lim.log.source_only')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

export const AlertsBox = (p: { locale: Locale; effective: EffectiveLimits; meta: LimitsMeta | null; ok?: string; error?: string }) => {
  const l = p.locale;
  const e = p.effective;
  const reason = pausedReason(e);
  return (
    <div class="box" id="alerts">
      <h2>{t(l, 'adm.lim.al.title')}</h2>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <p>
        {t(l, 'adm.lim.al.state')}{' '}
        {reason ? <b>{t(l, 'adm.lim.al.state.paused')}</b> : <b>{t(l, 'adm.lim.al.state.sending')}</b>}
        {reason && <span class="muted"> — {t(l, `adm.lim.al.reason.${reason}`)}</span>}
      </p>
      <p class="hint">{t(l, 'adm.lim.now')} <span class="badge">{sourceText(l, e.source.alerts_enabled)}</span></p>
      <LastChange locale={l} meta={p.meta} />
      <form method="post" action="/admin/settings/alerts">
        <fieldset>
          <legend>{t(l, 'adm.lim.al.legend')}</legend>
          <label class="check"><input type="radio" name="enabled" value="1" checked={e.alertsEnabled} required />{t(l, 'adm.lim.al.on_long')}</label>
          <label class="check"><input type="radio" name="enabled" value="0" checked={!e.alertsEnabled} />{t(l, 'adm.lim.al.off_long')}</label>
        </fieldset>
        <ul class="hint">
          <li>{t(l, 'adm.lim.al.note.off')}</li>
          <li>{t(l, 'adm.lim.al.note.users')}</li>
          <li>{t(l, 'adm.lim.al.note.on')}</li>
          <li>{t(l, 'adm.lim.al.note.zero')}</li>
        </ul>
        <div class="actions">
          <button type="submit" name="mode" value="save">{t(l, 'adm.lim.next')}</button>
          <button type="submit" name="mode" value="reset" class="plain" formnovalidate>{t(l, 'adm.lim.al.reset')}</button>
        </div>
      </form>
    </div>
  );
};

/** 확인 화면의 "오늘 쓴 수" (usage_counters 범위마다 가장 많이 쓴 대상의 수 — 사이트 몫이면 사이트 합계). */
export type UsageByScope = Record<string, { max: number; subjects: number }>;

/** 한도·알림 확인 화면. 바뀌는 값(값 또는 출처)과 결과를 보이고 "확인했습니다" 를 체크해야 저장된다. 새 값·기준은 숨은 칸. */
export const LimitsConfirmPage = (p: {
  locale: Locale; kind: 'limits' | 'alerts'; mode: 'save' | 'reset'; before: EffectiveLimits; after: EffectiveLimits;
  usage: UsageByScope; day: string; hidden: Record<string, string>; error?: string;
}) => {
  const l = p.locale;
  const b = p.before, a = p.after;
  const rows = p.kind === 'limits' ? LIMIT_KEYS.filter((k) => b.values[k] !== a.values[k] || b.source[k] !== a.source[k]) : [];
  const alertRow = p.kind === 'alerts' && (b.alertsEnabled !== a.alertsEnabled || b.source.alerts_enabled !== a.source.alerts_enabled);
  const onOff = (on: boolean) => t(l, on ? 'adm.lim.al.on' : 'adm.lim.al.off');
  const effects: Array<{ text: string; warn?: boolean }> = [];
  if (p.mode === 'reset') effects.push({ text: t(l, p.kind === 'limits' ? 'adm.lim.c.reset' : 'adm.lim.c.al_reset') });
  for (const k of rows) {
    const from = b.values[k], to = a.values[k];
    const s = limitSpecOf(k);
    if (to === from) { effects.push({ text: fill(t(l, 'adm.lim.c.source_only'), { item: t(l, `adm.lim.f.${k}`) }) }); continue; }
    const item = t(l, `adm.lim.f.${k}`);
    if (to > from) effects.push({ text: fill(t(l, 'adm.lim.c.raise'), { item }) });
    if (to < from) {
      if (k === 'DRAFT_JOBS_PER_COMPANY') effects.push({ text: fill(t(l, 'adm.lim.c.lower_drafts'), { n: to }) });
      else if (k === 'ALERT_SEND_PER_RUN') effects.push({ text: fill(t(l, 'adm.lim.c.lower_run'), { n: to, day: to * ALERT_RUNS_PER_DAY, runs: ALERT_RUNS_PER_DAY }) });
      else if (s.scope) {
        const u = p.usage[s.scope];
        const used = u?.max ?? 0;
        if (s.perSubject) {
          effects.push(used >= to
            ? { text: fill(t(l, 'adm.lim.c.lower_subject_hit'), { item, max: used, n: to }), warn: true }
            : { text: fill(t(l, used === 0 ? 'adm.lim.c.lower_subject_none' : 'adm.lim.c.lower_subject'), { item, max: used, n: to }) });
        } else {
          effects.push(used >= to
            ? { text: fill(t(l, 'adm.lim.c.lower_site_hit'), { item, used, n: to }), warn: true }
            : { text: fill(t(l, 'adm.lim.c.lower_site'), { item, used, left: to - used }) });
        }
      }
    }
    if (to === 0) effects.push({ text: t(l, `adm.lim.c.zero.${k}`), warn: true });
  }
  if (alertRow && b.alertsEnabled && !a.alertsEnabled) {
    for (const key of ['adm.lim.c.al_off.send', 'adm.lim.c.al_off.users', 'adm.lim.c.al_off.manage', 'adm.lim.c.al_off.anon']) effects.push({ text: t(l, key) });
  }
  if (alertRow && !b.alertsEnabled && a.alertsEnabled) {
    effects.push({ text: t(l, 'adm.lim.c.al_on.send') });
    effects.push({ text: t(l, 'adm.lim.c.al_on.backlog') });
  }
  const wasPaused = alertsPaused(b), nowPaused = alertsPaused(a);
  if (p.kind === 'limits' && !wasPaused && nowPaused) effects.push({ text: t(l, 'adm.lim.c.al_paused_by_limit'), warn: true });
  if (p.kind === 'limits' && wasPaused && !nowPaused) effects.push({ text: t(l, 'adm.lim.c.al_on.backlog') });
  if (nowPaused && a.alertsEnabled && p.kind === 'alerts') effects.push({ text: t(l, `adm.lim.c.still_paused.${pausedReason(a)}`), warn: true });
  if (mailPlanWarning(a.values) && !mailPlanWarning(b.values)) {
    effects.push({ text: fill(t(l, 'adm.lim.plan_warn'), { mail: a.values.MAIL_SITE_DAY, alert: a.values.ALERT_MAIL_SITE_DAY, sum: a.values.MAIL_SITE_DAY + a.values.ALERT_MAIL_SITE_DAY, max: FREE_PLAN_MAIL_WARN }), warn: true });
  }
  if (p.kind === 'limits') effects.push({ text: fill(t(l, 'adm.lim.c.counts_kept'), { day: p.day }) });
  effects.push({ text: t(l, 'adm.lim.c.now') });
  const back = p.kind === 'limits' ? '/admin/settings#limits' : '/admin/settings#alerts';
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a> · <a href={back}>{t(l, 'adm.set.title')}</a></p>
      <h1>{t(l, p.kind === 'limits' ? 'adm.lim.confirm.title' : 'adm.lim.al.confirm.title')}</h1>
      <Flash locale={l} error={p.error} />
      <div class="box">
        <p>{t(l, 'adm.ret.confirm.lead')}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>{t(l, 'adm.ret.confirm.item')}</th><th>{t(l, 'adm.ret.confirm.now')}</th><th>{t(l, 'adm.ret.confirm.after')}</th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr>
                <td>{t(l, `adm.lim.f.${k}`)}</td>
                <td>{limitValueText(l, k, b.values[k])} <span class="muted">({sourceText(l, b.source[k])})</span></td>
                <td><b>{limitValueText(l, k, a.values[k])}</b> <span class="muted">({sourceText(l, a.source[k])})</span></td>
              </tr>
            ))}
            {alertRow && (
              <tr>
                <td>{t(l, 'adm.lim.al.short')}</td>
                <td>{onOff(b.alertsEnabled)} <span class="muted">({sourceText(l, b.source.alerts_enabled)})</span></td>
                <td><b>{onOff(a.alertsEnabled)}</b> <span class="muted">({sourceText(l, a.source.alerts_enabled)})</span></td>
              </tr>
            )}
          </tbody>
        </table></div>
      </div>
      <div class="box">
        <h2>{t(l, 'adm.ret.confirm.effects')}</h2>
        <ul>{effects.map((x) => <li class={x.warn ? 'warn' : undefined}>{x.text}</li>)}</ul>
      </div>
      <form method="post" action={`/admin/settings/${p.kind}/confirm`} class="box">
        {Object.entries(p.hidden).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
        <label class="check"><input type="checkbox" name="confirm" value="1" required />{t(l, 'adm.ret.confirm.check')}</label>
        <div class="actions">
          <button type="submit">{t(l, 'adm.ret.confirm.submit')}</button>
          <a href={back}>{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};

/** /admin/system 의 표: 지금 쓰는 값과 출처, 알림 발송 상태. 읽기만 — 바꾸는 곳은 사이트 설정. */
export const LimitsSystemBox = ({ locale, limits }: { locale: Locale; limits: EffectiveLimits }) => {
  const l = locale;
  const reason = pausedReason(limits);
  return (
    <div class="box">
      <h2>{t(l, 'sys.lim.title')}</h2>
      <p>
        {t(l, 'adm.lim.al.state')}{' '}
        {reason ? <b>{t(l, 'adm.lim.al.state.paused')}</b> : <b>{t(l, 'adm.lim.al.state.sending')}</b>}
        {reason && <span class="muted"> — {t(l, `adm.lim.al.reason.${reason}`)}</span>}
        {' '}<span class="muted">({sourceText(l, limits.source.alerts_enabled)})</span>
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>{t(l, 'adm.ret.confirm.item')}</th><th>{t(l, 'sys.lim.value')}</th><th>{t(l, 'sys.lim.source')}</th></tr></thead>
        <tbody>
          {LIMIT_SPEC.map((s) => (
            <tr>
              <th>{t(l, `adm.lim.f.${s.key}`)}</th>
              <td class="num">{limitValueText(l, s.key, limits.values[s.key])}</td>
              <td>{sourceText(l, limits.source[s.key])}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <PlanWarning locale={l} e={limits} />
      <p class="hint">{t(l, 'sys.lim.note')} <a href="/admin/settings#limits">{t(l, 'adm.set.title')}</a></p>
    </div>
  );
};
