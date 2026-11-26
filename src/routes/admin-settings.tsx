// 관리자 사이트 설정 (/admin/settings, T-06d · T-12c). /admin 아래이므로 requireRole('admin') 을 이미 통과했다.
// 바꿀 수 있는 것: 채용정보 목록(/jobs)에 보일 검색 조건, 보관 기간, 사용량 한도·조건 알림 켜기/끄기(T-17). 공고를 고치거나 게재하는 기능은 없다.
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
import { usageMaxByScope } from '../db/usage';
import {
  appendLimitsLog, formFromLimits, parseLimitsLog, parseStoredLimits, planAlertsSave, planLimitsSave, readAlertsChoice, readLimitsForm, resolveLimits,
  serializeStoredLimits, validateLimitsForm, LIMIT_KEYS, LIMITS_LOG_SETTING, LIMITS_SETTING,
  type LimitFieldError, type LimitKey, type LimitsForm, type StoredLimits,
} from '../lib/limits';
import { kstDay } from '../lib/quota';
import { LimitsConfirmPage } from '../views/admin-limits';

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

/** 사용량 한도·알림 설정(T-17) + 마지막 변경(누가·언제) + 변경 기록. 읽기 두 번. */
async function loadLimitsState(c: Context<AppEnv>) {
  const [row, log] = await Promise.all([getSettingWithMeta(c.env.DB, LIMITS_SETTING), getSetting(c.env.DB, LIMITS_LOG_SETTING)]);
  return {
    stored: parseStoredLimits(row?.value ?? null),
    effective: resolveLimits(c.env, row?.value ?? null),
    meta: row ? { by: row.updated_by_email ?? row.updated_by, at: row.updated_at } : null,
    log: parseLimitsLog(log),
  };
}

type LimitsBoxState = { form?: LimitsForm; errors?: Partial<Record<LimitKey, LimitFieldError>>; ok?: string; error?: string };

async function settingsPage(
  c: Context<AppEnv>,
  ret: { form?: RetentionForm; errors?: Partial<Record<RetentionKey, RetentionFieldError>>; ok?: string; error?: string } = {},
  status: 200 | 400 = 200,
  lim: { limits?: LimitsBoxState; alerts?: { ok?: string; error?: string } } = {},
) {
  const [filters, st, ls] = await Promise.all([getSetting(c.env.DB, PUBLIC_FILTERS_SETTING), loadRetentionState(c), loadLimitsState(c)]);
  const ok = c.req.query('ok') === 'saved' ? 'adm.set.ok.saved' : undefined;
  return render(c, (
    <AdminSettingsPage locale={c.var.locale} enabled={parseEnabledFilters(filters)} ok={ok}
      retention={{ form: ret.form ?? formFromRetention(st.current), errors: ret.errors, meta: st.meta, log: st.log, ok: ret.ok, error: ret.error }}
      limits={{
        effective: ls.effective, meta: ls.meta, log: ls.log, form: lim.limits?.form ?? formFromLimits(ls.effective.values),
        errors: lim.limits?.errors, ok: lim.limits?.ok, error: lim.limits?.error, alertsOk: lim.alerts?.ok, alertsError: lim.alerts?.error,
      }} />
  ), 'adm.set.title', status);
}

const LIM_OK: Record<string, string> = {
  limits_saved: 'adm.lim.ok.saved', limits_unchanged: 'adm.lim.ok.unchanged', limits_reset: 'adm.lim.ok.reset',
};
const AL_OK: Record<string, string> = { alerts_saved: 'adm.lim.al.ok.saved', alerts_unchanged: 'adm.lim.ok.unchanged', alerts_reset: 'adm.lim.al.ok.reset' };

adminSettings.get('/settings', (c) => {
  const q = c.req.query('ok') ?? '';
  return settingsPage(c, { ok: RET_OK[q] }, 200, { limits: { ok: LIM_OK[q] }, alerts: { ok: AL_OK[q] } });
});

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

// ───────── 사용량 한도·조건 알림 켜기/끄기 (T-17, lib/limits)
// - 두 단계: POST /admin/settings/limits | /alerts (검사 → 확인 화면, 아무것도 저장하지 않음) → POST …/confirm ("확인했습니다" 필수 → 저장).
// - mode=reset: "기본값으로 되돌리기" — 그 폼의 관리자 값을 지운다 (설정 파일 값이 있으면 그것, 없으면 기본값). 같은 확인 화면을 거친다.
// - 확인 화면에 지금 저장된 값(base)을 숨은 칸으로 넣고, 저장할 때 다시 읽은 값과 다르면(그사이 다른 관리자가 바꿈) 저장하지 않고 다시 확인받는다.
// - 저장은 site_settings 'limits'(updated_by·updated_at = 누가·언제) + 'limits.log'(시각·관리자 id·숫자만, 최근 20줄)를 한 트랜잭션으로.
// - 다시 배포할 필요 없다: 한도를 잡는 곳·알림 화면·예약 작업이 요청(실행)마다 이 한 행을 읽는다 (캐시 없음).

type Plan = ReturnType<typeof planLimitsSave>;

const readMode = (v: unknown): 'save' | 'reset' => (v === 'reset' ? 'reset' : 'save');

async function confirmPage(
  c: Context<AppEnv>, kind: 'limits' | 'alerts', mode: 'save' | 'reset', plan: Plan, base: string, hidden: Record<string, string>,
  error?: string,
) {
  const day = kstDay(now());
  const usage = kind === 'limits' ? await usageMaxByScope(c.env.DB, day) : {};
  return render(c, (
    <LimitsConfirmPage locale={c.var.locale} kind={kind} mode={mode} before={plan.before} after={plan.after} usage={usage} day={day}
      hidden={{ ...hidden, mode, base }} error={error} />
  ), kind === 'limits' ? 'adm.lim.confirm.title' : 'adm.lim.al.confirm.title', error ? 400 : 200);
}

const unchanged = (current: StoredLimits, plan: Plan) => serializeStoredLimits(current) === serializeStoredLimits(plan.stored);

async function saveLimits(c: Context<AppEnv>, plan: Plan, reset: boolean) {
  const ts = now();
  const by = c.var.user!.id;
  const log = appendLimitsLog(await getSetting(c.env.DB, LIMITS_LOG_SETTING), { at: ts, by, ...(reset ? { reset: true } : {}), changes: plan.changes });
  await setSettings(c.env.DB, [
    { key: LIMITS_SETTING, value: serializeStoredLimits(plan.stored) },
    { key: LIMITS_LOG_SETTING, value: log },
  ], by, ts);
}

const limitsHidden = (form: LimitsForm): Record<string, string> => Object.fromEntries(LIMIT_KEYS.map((k) => [k, form[k]]));

/** 한도 폼 → 계획. 저장(save)은 폼 검사, 되돌리기(reset)는 값을 보지 않는다. */
async function limitsPlan(c: Context<AppEnv>, f: Record<string, unknown>) {
  const mode = readMode(f.mode);
  const form = readLimitsForm(f);
  const { stored } = await loadLimitsState(c);
  if (mode === 'reset') return { mode, form, stored, plan: planLimitsSave(c.env, stored, 'reset') } as const;
  const v = validateLimitsForm(form);
  if (!v.ok) return { mode, form, stored, errors: v.errors } as const;
  return { mode, form, stored, plan: planLimitsSave(c.env, stored, v.value) } as const;
}

adminSettings.post('/settings/limits', async (c) => {
  const x = await limitsPlan(c, await c.req.parseBody());
  if (!x.plan) return settingsPage(c, {}, 400, { limits: { form: x.form, errors: x.errors } });
  if (unchanged(x.stored, x.plan)) return c.redirect('/admin/settings?ok=limits_unchanged#limits', 303);
  return confirmPage(c, 'limits', x.mode, x.plan, serializeStoredLimits(x.stored), x.mode === 'save' ? limitsHidden(x.form) : {});
});

adminSettings.post('/settings/limits/confirm', async (c) => {
  const f = await c.req.parseBody();
  const x = await limitsPlan(c, f);
  if (!x.plan) return settingsPage(c, {}, 400, { limits: { form: x.form, errors: x.errors } });
  if (unchanged(x.stored, x.plan)) return c.redirect('/admin/settings?ok=limits_unchanged#limits', 303);
  const base = serializeStoredLimits(x.stored);
  const hidden = x.mode === 'save' ? limitsHidden(x.form) : {};
  // 확인 화면을 연 뒤 다른 관리자가 바꿨으면 지금 값 기준으로 다시 확인받는다 (확인한 지금 → 바꾼 뒤 와 실제가 다르므로).
  if (f.base !== base) return confirmPage(c, 'limits', x.mode, x.plan, base, hidden, 'adm.ret.err.stale');
  if (f.confirm !== '1') return confirmPage(c, 'limits', x.mode, x.plan, base, hidden, 'adm.ret.err.confirm');
  await saveLimits(c, x.plan, x.mode === 'reset');
  return c.redirect(`/admin/settings?ok=${x.mode === 'reset' ? 'limits_reset' : 'limits_saved'}#limits`, 303);
});

async function alertsPlan(c: Context<AppEnv>, f: Record<string, unknown>) {
  const mode = readMode(f.mode);
  const { stored } = await loadLimitsState(c);
  const choice = mode === 'reset' ? 'reset' as const : readAlertsChoice(f.enabled);
  return { mode, stored, choice, plan: choice === null ? null : planAlertsSave(c.env, stored, choice) };
}

adminSettings.post('/settings/alerts', async (c) => {
  const x = await alertsPlan(c, await c.req.parseBody());
  if (!x.plan) return settingsPage(c, {}, 400, { alerts: { error: 'adm.lim.al.err.choice' } });
  if (unchanged(x.stored, x.plan)) return c.redirect('/admin/settings?ok=alerts_unchanged#alerts', 303);
  return confirmPage(c, 'alerts', x.mode, x.plan, serializeStoredLimits(x.stored), x.choice === 'reset' ? {} : { enabled: x.choice ? '1' : '0' });
});

adminSettings.post('/settings/alerts/confirm', async (c) => {
  const f = await c.req.parseBody();
  const x = await alertsPlan(c, f);
  if (!x.plan) return settingsPage(c, {}, 400, { alerts: { error: 'adm.lim.al.err.choice' } });
  if (unchanged(x.stored, x.plan)) return c.redirect('/admin/settings?ok=alerts_unchanged#alerts', 303);
  const base = serializeStoredLimits(x.stored);
  const hidden: Record<string, string> = x.choice === 'reset' ? {} : { enabled: x.choice ? '1' : '0' };
  if (f.base !== base) return confirmPage(c, 'alerts', x.mode, x.plan, base, hidden, 'adm.ret.err.stale');
  if (f.confirm !== '1') return confirmPage(c, 'alerts', x.mode, x.plan, base, hidden, 'adm.ret.err.confirm');
  await saveLimits(c, x.plan, x.mode === 'reset');
  return c.redirect(`/admin/settings?ok=${x.mode === 'reset' ? 'alerts_reset' : 'alerts_saved'}#alerts`, 303);
});
