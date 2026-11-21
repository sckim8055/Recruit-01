// 관리자 사이트 설정 (T-06d). 지금은 채용정보 목록(/jobs)에 보일 검색 조건만 고른다.
// 이 화면은 검색 칸의 표시만 바꾼다 — 공고 내용·게재 상태·공고 작성 폼은 바뀌지 않는다.
import type { Locale } from '../env';
import { t } from '../lib/i18n';
import { FILTER_KEYS, type FilterKey } from '../lib/public-jobs';
import { Flash } from './company';
import { FILTER_LABELS } from './public-jobs';

export const AdminSettingsPage = ({ locale, enabled, ok }: { locale: Locale; enabled: readonly FilterKey[]; ok?: string }) => {
  const l = locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a></p>
      <h1>{t(l, 'adm.set.title')}</h1>
      <Flash locale={l} ok={ok} />
      <div class="box">
        <h2>{t(l, 'adm.set.filters')}</h2>
        <p class="muted">{t(l, 'adm.set.filters_lead')}</p>
        <form method="post" action="/admin/settings">
          <fieldset>
            <legend>{t(l, 'adm.set.filters_legend')}</legend>
            {FILTER_KEYS.map((k) => (
              <label class="check">
                <input type="checkbox" name="filters" value={k} checked={enabled.includes(k)} />
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
      <div class="box">
        <h2>{t(l, 'adm.opt.title')}</h2>
        <p class="muted">{t(l, 'adm.set.options_lead')}</p>
        <p><a href="/admin/options">{t(l, 'adm.opt.title')}</a></p>
      </div>
    </section>
  );
};
