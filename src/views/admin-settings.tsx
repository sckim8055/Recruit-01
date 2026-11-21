// 관리자 사이트 설정 (T-06d, T-12c). 채용정보 목록(/jobs)에 보일 검색 조건, 보관 기간.
// 검색 조건은 검색 칸의 표시만 바꾼다 — 공고 내용·게재 상태·공고 작성 폼은 바뀌지 않는다.
// 보관 기간은 두 단계로 저장한다(자바스크립트 없음): 폼 → 확인 화면(바뀌는 값 old → new, 결과, "확인했습니다") → 저장.
import type { Locale } from '../env';
import { fmtDateTime } from '../lib/company';
import { t } from '../lib/i18n';
import { FILTER_KEYS, type FilterKey } from '../lib/public-jobs';
import {
  RETENTION_SPEC, specOf, type RetentionChange, type RetentionFieldError, type RetentionForm, type RetentionKey, type RetentionLogEntry,
  type RetentionSettings, type RetentionValues,
} from '../lib/retention';
import { Flash } from './company';
import { FILTER_LABELS } from './public-jobs';

const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);

/** 기간 값 → 화면 글 ("90일", 끈 자동 마감은 "끔"). */
export const retentionValueText = (l: Locale, k: RetentionKey, n: number): string =>
  k === 'job_stale_days' && n === 0 ? t(l, 'adm.ret.off') : fill(t(l, 'adm.ret.days'), { n });

const rangeText = (l: Locale, k: RetentionKey) => {
  const s = specOf(k);
  return fill(t(l, s.offAllowed ? 'adm.ret.range_off' : 'adm.ret.range'), { min: s.min, max: s.max, def: s.default });
};

const errText = (l: Locale, k: RetentionKey, e: RetentionFieldError) => {
  const s = specOf(k);
  return fill(t(l, `adm.ret.err.${e}${e === 'out_of_range' && s.offAllowed ? '_off' : ''}`), { min: s.min, max: s.max });
};

export interface RetentionMeta { by: string | null; at: number }

export const RetentionBox = (p: {
  locale: Locale; form: RetentionForm; errors?: Partial<Record<RetentionKey, RetentionFieldError>>; meta: RetentionMeta | null;
  log: RetentionLogEntry[]; ok?: string; error?: string;
}) => {
  const l = p.locale;
  const errors = p.errors ?? {};
  return (
    <div class="box" id="retention">
      <h2>{t(l, 'adm.ret.title')}</h2>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <p class="muted">{t(l, 'adm.ret.lead')}</p>
      <ul class="hint">
        <li>{t(l, 'adm.ret.note.personal')}</li>
        <li>{t(l, 'adm.ret.note.shorten')}</li>
        <li>{t(l, 'adm.ret.note.lengthen')}</li>
        <li>{t(l, 'adm.ret.note.policy')}</li>
      </ul>
      <p class="muted">
        {p.meta ? fill(t(l, 'adm.ret.last'), { who: p.meta.by ?? t(l, 'adm.ret.last_unknown'), at: fmtDateTime(p.meta.at) }) : t(l, 'adm.ret.never')}
      </p>
      {Object.keys(errors).length > 0 && <p class="error">{t(l, 'adm.ret.err.form')}</p>}
      <form method="post" action="/admin/settings/retention">
        {RETENTION_SPEC.map((s) => (
          <label>
            {t(l, `adm.ret.f.${s.key}`)}
            <input type="number" name={s.key} value={p.form[s.key]} min={s.offAllowed ? 0 : s.min} max={s.max} step={1}
              required={!s.offAllowed} inputmode="numeric" />
            <span class="hint">{rangeText(l, s.key)} {t(l, `adm.ret.h.${s.key}`)}</span>
            {errors[s.key] && <span class="error">{errText(l, s.key, errors[s.key]!)}</span>}
            {s.offAllowed && (
              <span class="check">
                <input type="checkbox" name="job_stale_off" value="1" checked={p.form.job_stale_off} />{t(l, 'adm.ret.stale_off')}
              </span>
            )}
          </label>
        ))}
        <p class="hint">{t(l, 'adm.ret.fixed')}</p>
        <button type="submit">{t(l, 'adm.ret.next')}</button>
      </form>
      {p.log.length > 0 && (
        <details class="spaced">
          <summary>{t(l, 'adm.ret.log.title')}</summary>
          <ul class="rows">
            {[...p.log].reverse().slice(0, 5).map((e) => (
              <li>
                <span class="muted">{fmtDateTime(e.at)}</span>
                <span>{e.changes.map((c) => `${t(l, `adm.ret.short.${c.key}`)} ${retentionValueText(l, c.key, c.from)} → ${retentionValueText(l, c.key, c.to)}`).join(', ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

export const AdminSettingsPage = (p: {
  locale: Locale; enabled: readonly FilterKey[]; ok?: string;
  retention: { form: RetentionForm; errors?: Partial<Record<RetentionKey, RetentionFieldError>>; meta: RetentionMeta | null; log: RetentionLogEntry[]; ok?: string; error?: string };
}) => {
  const l = p.locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a></p>
      <h1>{t(l, 'adm.set.title')}</h1>
      <Flash locale={l} ok={p.ok} />
      <div class="box">
        <h2>{t(l, 'adm.set.filters')}</h2>
        <p class="muted">{t(l, 'adm.set.filters_lead')}</p>
        <form method="post" action="/admin/settings">
          <fieldset>
            <legend>{t(l, 'adm.set.filters_legend')}</legend>
            {FILTER_KEYS.map((k) => (
              <label class="check">
                <input type="checkbox" name="filters" value={k} checked={p.enabled.includes(k)} />
                {t(l, FILTER_LABELS[k])}
              </label>
            ))}
          </fieldset>
          <p class="hint">{t(l, 'adm.set.filters_hint')}</p>
          <p class="hint">{t(l, 'adm.set.filters_none')}</p>
          <p class="hint">{t(l, 'adm.set.cache_note')}</p>
          <button type="submit">{t(l, 'common.save')}</button>
        </form>
      </div>
      <RetentionBox locale={l} {...p.retention} />
      <div class="box">
        <h2>{t(l, 'adm.opt.title')}</h2>
        <p class="muted">{t(l, 'adm.set.options_lead')}</p>
        <p><a href="/admin/options">{t(l, 'adm.opt.title')}</a></p>
      </div>
    </section>
  );
};

/** 보관 기간 확인 화면. 바뀌는 값과 그 결과를 보이고 "확인했습니다" 를 체크해야 저장된다. 새 값과 기준(지금 값)은 숨은 칸. */
export const RetentionConfirmPage = (p: {
  locale: Locale; current: RetentionSettings; next: RetentionValues; changes: RetentionChange[];
  shortened: RetentionKey[]; lengthened: RetentionKey[]; reconsent: boolean; base: string; error?: string;
}) => {
  const l = p.locale;
  const names = (ks: RetentionKey[]) => ks.map((k) => t(l, `adm.ret.short.${k}`)).join(', ');
  const staleOff = p.changes.some((c) => c.key === 'job_stale_days' && c.to === 0);
  const appLonger = p.lengthened.includes('application_keep_days');
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a> · <a href="/admin/settings#retention">{t(l, 'adm.set.title')}</a></p>
      <h1>{t(l, 'adm.ret.confirm.title')}</h1>
      <Flash locale={l} error={p.error} />
      <div class="box">
        <p>{t(l, 'adm.ret.confirm.lead')}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>{t(l, 'adm.ret.confirm.item')}</th><th>{t(l, 'adm.ret.confirm.now')}</th><th>{t(l, 'adm.ret.confirm.after')}</th></tr></thead>
          <tbody>
            {p.changes.map((c) => (
              <tr>
                <td>{t(l, `adm.ret.f.${c.key}`)}</td>
                <td>{retentionValueText(l, c.key, c.from)}</td>
                <td><b>{retentionValueText(l, c.key, c.to)}</b></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <div class="box">
        <h2>{t(l, 'adm.ret.confirm.effects')}</h2>
        <ul>
          {p.shortened.length > 0 && <li class="warn">{fill(t(l, 'adm.ret.c.shorten'), { items: names(p.shortened) })}</li>}
          {p.shortened.includes('application_keep_days') && <li>{t(l, 'adm.ret.c.shorten_app')}</li>}
          {p.lengthened.length > 0 && <li>{fill(t(l, 'adm.ret.c.lengthen'), { items: names(p.lengthened) })}</li>}
          {appLonger && <li>{t(l, 'adm.ret.c.lengthen_app')}</li>}
          {p.reconsent && <li class="warn">{t(l, 'adm.ret.c.reconsent')}</li>}
          {staleOff && <li>{t(l, 'adm.ret.c.stale_off')}</li>}
          {!p.shortened.length && !p.lengthened.length && <li>{t(l, 'adm.ret.c.none')}</li>}
          <li>{t(l, 'adm.ret.c.policy')}</li>
        </ul>
      </div>
      <form method="post" action="/admin/settings/retention/confirm" class="box">
        {RETENTION_SPEC.map((s) => <input type="hidden" name={s.key} value={String(p.next[s.key])} />)}
        <input type="hidden" name="base" value={p.base} />
        <label class="check"><input type="checkbox" name="confirm" value="1" required />{t(l, 'adm.ret.confirm.check')}</label>
        <div class="actions">
          <button type="submit">{t(l, 'adm.ret.confirm.submit')}</button>
          <a href="/admin/settings#retention">{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};
