// 관리자 사이트 설정 (/admin/settings, T-06d · T-12c). /admin 아래이므로 requireRole('admin') 을 이미 통과했다.
// 바꿀 수 있는 것: 채용정보 목록(/jobs)에 보일 검색 조건, 보관 기간. 공고를 고치거나 게재하는 기능은 없다.
//
// 보관 기간 (T-12c, lib/retention):
// - 두 단계: POST /admin/settings/retention(검사 → 확인 화면) → POST /admin/settings/retention/confirm("확인했습니다" 필수 → 저장).
// - 확인 화면에는 지금 값(base)을 숨은 칸으로 넣고, 저장할 때 다시 읽은 값과 다르면(그사이 다른 관리자가 바꿈) 저장하지 않는다.
// - 개인정보 기간을 하나라도 늘리면 rev 가 오르고 → 개인정보처리방침 판이 바뀌어 모든 회원에게 다시 동의를 받는다 (lib/consent.privacyVersion).
// - 저장할 때 'retention.log' 에 한 줄(시각·관리자 id·바뀐 값 old → new, 숫자만, 최근 20줄)을 같은 트랜잭션으로 남긴다.
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import { parseEnabledFilters, PUBLIC_FILTERS_SETTING, readEnabledFiltersForm, serializeEnabledFilters } from '../lib/public-jobs';
import {
  appendRetentionLog, formFromRetention, parseRetention, parseRetentionLog, planRetentionSave, readRetentionForm, serializeRetention,
  validateRetentionForm, RETENTION_LOG_SETTING, RETENTION_SETTING, type RetentionFieldError, type RetentionForm, type RetentionKey,
} from '../lib/retention';
import { render } from '../render';
import { AdminSettingsPage, RetentionConfirmPage } from '../views/admin-settings';
import { getSetting, getSettingWithMeta, setSetting, setSettings } from '../db/settings';

export const adminSettings = new Hono<AppEnv>();

const RET_OK: Record<string, string> = { retention_saved: 'adm.ret.ok.saved', retention_unchanged: 'adm.ret.ok.unchanged' };

/** 보관 기간 설정 + 마지막 변경(누가·언제) + 변경 기록. 읽기 두 번. */
async function loadRetentionState(c: Context<AppEnv>) {
  const [row, log] = await Promise.all([getSettingWithMeta(c.env.DB, RETENTION_SETTING), getSetting(c.env.DB, RETENTION_LOG_SETTING)]);
  return {
    current: parseRetention(row?.value ?? null),
    meta: row ? { by: row.updated_by_email ?? row.updated_by, at: row.updated_at } : null,
    log: parseRetentionLog(log),
  };
}

async function settingsPage(
  c: Context<AppEnv>,
  ret: { form?: RetentionForm; errors?: Partial<Record<RetentionKey, RetentionFieldError>>; ok?: string; error?: string } = {},
  status: 200 | 400 = 200,
) {
  const [filters, st] = await Promise.all([getSetting(c.env.DB, PUBLIC_FILTERS_SETTING), loadRetentionState(c)]);
  const ok = c.req.query('ok') === 'saved' ? 'adm.set.ok.saved' : undefined;
  return render(c, (
    <AdminSettingsPage locale={c.var.locale} enabled={parseEnabledFilters(filters)} ok={ok}
      retention={{ form: ret.form ?? formFromRetention(st.current), errors: ret.errors, meta: st.meta, log: st.log, ok: ret.ok, error: ret.error }} />
  ), 'adm.set.title', status);
}

adminSettings.get('/settings', (c) => settingsPage(c, { ok: RET_OK[c.req.query('ok') ?? ''] }));

// 체크한 필터만 온다 (모두 끄면 값이 없다 → 빈 목록으로 저장). FILTER_KEYS 에 없는 값은 버린다.
adminSettings.post('/settings', async (c) => {
  const f = await c.req.parseBody({ all: true });
  const keys = readEnabledFiltersForm(f.filters);
  await setSetting(c.env.DB, PUBLIC_FILTERS_SETTING, serializeEnabledFilters(keys), c.var.user!.id, now());
  return c.redirect('/admin/settings?ok=saved');
});

// ── 보관 기간: 1단계 (검사 → 확인 화면). 아무것도 저장하지 않는다.
adminSettings.post('/settings/retention', async (c) => {
  const form = readRetentionForm(await c.req.parseBody());
  const v = validateRetentionForm(form);
  if (!v.ok) return settingsPage(c, { form, errors: v.errors }, 400);
  const { current } = await loadRetentionState(c);
  const plan = planRetentionSave(current, v.value);
  if (!plan.changes.length) return c.redirect('/admin/settings?ok=retention_unchanged#retention', 303);
  return render(c, (
    <RetentionConfirmPage locale={c.var.locale} current={current} next={v.value} changes={plan.changes} shortened={plan.shortened}
      lengthened={plan.lengthened} reconsent={plan.reconsent} base={serializeRetention(current)} />
  ), 'adm.ret.confirm.title');
});

// ── 보관 기간: 2단계 (확인 → 저장)
adminSettings.post('/settings/retention/confirm', async (c) => {
  const f = await c.req.parseBody();
  const form = readRetentionForm(f);
  const v = validateRetentionForm(form);
  if (!v.ok) return settingsPage(c, { form, errors: v.errors }, 400);
  const { current } = await loadRetentionState(c);
  const plan = planRetentionSave(current, v.value);
  const confirmPage = (error: string) => render(c, (
    <RetentionConfirmPage locale={c.var.locale} current={current} next={v.value} changes={plan.changes} shortened={plan.shortened}
      lengthened={plan.lengthened} reconsent={plan.reconsent} base={serializeRetention(current)} error={error} />
  ), 'adm.ret.confirm.title', 400);
  // 확인 화면을 연 뒤 다른 관리자가 바꿨으면 지금 값 기준으로 다시 확인받는다 (확인한 old → new 와 실제가 다르므로).
  if (f.base !== serializeRetention(current)) {
    if (!plan.changes.length) return c.redirect('/admin/settings?ok=retention_unchanged#retention', 303);
    return confirmPage('adm.ret.err.stale');
  }
  if (!plan.changes.length) return c.redirect('/admin/settings?ok=retention_unchanged#retention', 303);
  if (f.confirm !== '1') return confirmPage('adm.ret.err.confirm');
  const ts = now();
  const by = c.var.user!.id;
  const log = appendRetentionLog(await getSetting(c.env.DB, RETENTION_LOG_SETTING), { at: ts, by, changes: plan.changes });
  await setSettings(c.env.DB, [
    { key: RETENTION_SETTING, value: serializeRetention(plan.value) },
    { key: RETENTION_LOG_SETTING, value: log },
  ], by, ts);
  return c.redirect('/admin/settings?ok=retention_saved#retention', 303);
});
