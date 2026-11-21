// 관리자 사이트 설정 (/admin/settings, T-06d). /admin 아래이므로 requireRole('admin') 을 이미 통과했다.
// 바꿀 수 있는 것: 채용정보 목록(/jobs)에 보일 검색 조건. 공고를 고치거나 게재하는 기능은 없다.
import { Hono } from 'hono';
import { now, type AppEnv } from '../env';
import { parseEnabledFilters, PUBLIC_FILTERS_SETTING, readEnabledFiltersForm, serializeEnabledFilters } from '../lib/public-jobs';
import { render } from '../render';
import { AdminSettingsPage } from '../views/admin-settings';
import { getSetting, setSetting } from '../db/settings';

export const adminSettings = new Hono<AppEnv>();

adminSettings.get('/settings', async (c) => {
  const enabled = parseEnabledFilters(await getSetting(c.env.DB, PUBLIC_FILTERS_SETTING));
  const ok = c.req.query('ok') === 'saved' ? 'adm.set.ok.saved' : undefined;
  return render(c, <AdminSettingsPage locale={c.var.locale} enabled={enabled} ok={ok} />, 'adm.set.title');
});

// 체크한 필터만 온다 (모두 끄면 값이 없다 → 빈 목록으로 저장). FILTER_KEYS 에 없는 값은 버린다.
adminSettings.post('/settings', async (c) => {
  const f = await c.req.parseBody({ all: true });
  const keys = readEnabledFiltersForm(f.filters);
  await setSetting(c.env.DB, PUBLIC_FILTERS_SETTING, serializeEnabledFilters(keys), c.var.user!.id, now());
  return c.redirect('/admin/settings?ok=saved');
});
