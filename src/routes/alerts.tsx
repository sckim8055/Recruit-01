// 조건 알림 (T-10).
// - /my/alerts: 구직자 본인만 (비로그인 → /login, 다른 역할 403). 모든 응답 private, no-store. 행은 항상 로그인 사용자 id 조건으로 읽고 바꾼다.
// - /alerts/u/:token: 메일의 해지 링크. 로그인하지 않으며, 토큰은 그 알림을 끄는 권한일 뿐이다 (조건 요약 말고는 보이지 않는다).
//   GET 은 아무것도 바꾸지 않는다 (메일 검사기가 링크를 미리 연다) → 확인 화면의 POST 버튼, 또는 메일 프로그램의 RFC 8058 한 번 클릭 POST.
//   그 한 번 클릭 POST 만 출처 검사에서 빠진다 (src/index.tsx, lib/alerts.isOneClickUnsubscribe). "모든 알림 끄기" 는 출처 검사를 받는다.
// 관리자가 남의 알림을 보거나 만들거나 보내는 경로는 없다 (관리자 화면에는 개수만).
// T-17: 관리자가 발송을 멈추면(lib/limits.alertsPaused) 새 알림 만들기만 거절하고, 목록·빈도·끄기·다시 켜기·삭제·해지 링크는 그대로 된다.
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import { requireRole } from '../lib/auth';
import { sha256Hex } from '../lib/crypto';
import {
  ALERT_MAX_PER_USER, ALERT_OPTIN_VERSION, effectiveFilter, filterSummaryItems, filterSummaryText, isAlertId, isEmptyFilter, isUnsubToken,
  nextDueAt, normalizeAlertFilter, parseStoredFilter, readFrequency, serializeFilter,
} from '../lib/alerts';
import { buildOptionSet, type OptionSet } from '../lib/options';
import { filterChoices, jobsHref, parseEnabledFilters, parseJobFilter, PUBLIC_FILTERS_SETTING, type FilterKey } from '../lib/public-jobs';
import { render } from '../render';
import { AlertCreateProblem, AlertList, UnsubConfirm, UnsubDone, UnsubInvalid, type AlertListItem } from '../views/alerts';
import { NO_STORE, noStore } from './guards';
import {
  deleteMyAlert, findAlertByToken, insertAlert, listMyAlerts, pauseAlertByToken, pauseAllByToken, pauseMyAlert, resumeMyAlert, setMyAlertFrequency,
} from '../db/alerts';
import { listOptions } from '../db/options';
import { getSetting } from '../db/settings';
import { loadLimits } from '../lib/quota';
import { alertsPaused } from '../lib/limits';

/** 보일 필터 설정 + 항목 목록 (동시에 두 번 읽기 — /jobs 와 같다). */
async function filterContext(c: Context<AppEnv>): Promise<{ enabled: FilterKey[]; set: OptionSet }> {
  const [setting, rows] = await Promise.all([getSetting(c.env.DB, PUBLIC_FILTERS_SETTING), listOptions(c.env.DB)]);
  return { enabled: parseEnabledFilters(setting), set: buildOptionSet(rows) };
}

const formStrings = (f: Record<string, unknown>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));

const OK_KEYS = new Set(['created', 'saved', 'paused', 'resumed', 'deleted']);
const ERR_KEYS = new Set(['consent', 'frequency', 'notfound']);

export const alerts = new Hono<AppEnv>();
alerts.use('*', noStore);
alerts.use('*', requireRole('seeker'));

async function listPage(c: Context<AppEnv>, o: { error?: string; status?: 200 | 400 } = {}) {
  const user = c.var.user!;
  // 발송 멈춤 안내(T-17)를 위해 한도 설정 한 행도 같이 읽는다 (읽기 3 → 4, 동시에).
  const [ctx, rows, limits] = await Promise.all([filterContext(c), listMyAlerts(c.env.DB, user.id), loadLimits(c.env)]);
  const items: AlertListItem[] = rows.map((row) => {
    const stored = parseStoredFilter(row.filter_json, ctx.set);
    const eff = effectiveFilter(stored, ctx.enabled).filter;
    return { row, items: filterSummaryItems(stored, c.var.locale, ctx.set, ctx.enabled), effective: eff, effectiveEmpty: isEmptyFilter(eff) };
  });
  const ok = c.req.query('ok');
  const qErr = c.req.query('err');
  const error = o.error ?? (qErr && ERR_KEYS.has(qErr) ? `alert.err.${qErr}` : undefined);
  return render(c, (
    <AlertList locale={c.var.locale} alerts={items} ok={ok && OK_KEYS.has(ok) ? `alert.ok.${ok}` : undefined} error={error} paused={alertsPaused(limits)} />
  ), 'alert.title', o.status ?? 200);
}

alerts.get('/', (c) => listPage(c));

// 만들기 (/jobs 의 칸에서). 조건은 /jobs 와 같은 파서로 다시 읽는다 — 숨은 칸을 고쳐 보내도 /jobs 가 받는 값만 남는다.
alerts.post('/', async (c) => {
  const user = c.var.user!;
  const form = formStrings(await c.req.parseBody());
  const [ctx, limits] = await Promise.all([filterContext(c), loadLimits(c.env)]);
  const choices = filterChoices(ctx.set);
  const back = jobsHref(parseJobFilter(form, ctx.enabled, choices));
  const problem = (error: string, vars?: Record<string, string | number>) =>
    render(c, <AlertCreateProblem locale={c.var.locale} error={error} vars={vars} back={back} />, 'alert.create.title', 400);
  // 발송이 멈춘 동안(T-17: 관리자가 끔 · 알림 메일 한도 0 · 처리 수 0)에는 새 알림을 만들지 않는다. 있는 알림의 관리·해지는 그대로 된다.
  if (alertsPaused(limits)) return problem('alert.err.paused');
  const filter = normalizeAlertFilter(form, ctx.enabled, choices);
  if (!filter) return problem('alert.err.empty');
  const frequency = readFrequency(form.frequency);
  if (!frequency) return problem('alert.err.frequency');
  if (form.optin !== '1') return problem('alert.err.consent');
  const ts = now();
  const r = await insertAlert(c.env.DB, {
    id: crypto.randomUUID(), seekerId: user.id, filterJson: serializeFilter(filter), frequency, now: ts, nextDue: nextDueAt(frequency, ts),
    optinVersion: ALERT_OPTIN_VERSION, max: ALERT_MAX_PER_USER,
  });
  if (r === 'limit') return problem('alert.err.limit', { max: ALERT_MAX_PER_USER });
  if (r === 'duplicate') return problem('alert.err.duplicate');
  return c.redirect('/my/alerts?ok=created', 303);
});

/** :id 가 알림 id 모양이 아니면 null (DB 를 읽지 않는다). */
const alertId = (c: Context<AppEnv>): string | null => { const id = c.req.param('id') ?? ''; return isAlertId(id) ? id : null; };

alerts.post('/:id/frequency', async (c) => {
  const id = alertId(c);
  const frequency = readFrequency((await c.req.parseBody()).frequency);
  if (!frequency) return c.redirect('/my/alerts?err=frequency', 303);
  const ts = now();
  const ok = id && await setMyAlertFrequency(c.env.DB, { id, seekerId: c.var.user!.id, frequency, nextDue: nextDueAt(frequency, ts), now: ts });
  return c.redirect(ok ? '/my/alerts?ok=saved' : '/my/alerts?err=notfound', 303);
});

alerts.post('/:id/pause', async (c) => {
  const id = alertId(c);
  const ok = id && await pauseMyAlert(c.env.DB, { id, seekerId: c.var.user!.id, now: now() });
  return c.redirect(ok ? '/my/alerts?ok=paused' : '/my/alerts?err=notfound', 303);
});

// 다시 켜기는 메일 수신 동의를 다시 받는다 (해지 링크로 끈 알림도 있으므로).
alerts.post('/:id/resume', async (c) => {
  const id = alertId(c);
  if ((await c.req.parseBody()).optin !== '1') return listPage(c, { error: 'alert.err.consent', status: 400 });
  const user = c.var.user!;
  const row = id ? (await listMyAlerts(c.env.DB, user.id)).find((a) => a.id === id) : undefined;
  const ts = now();
  const ok = row && await resumeMyAlert(c.env.DB, { id: row.id, seekerId: user.id, now: ts, nextDue: nextDueAt(row.frequency, ts), optinVersion: ALERT_OPTIN_VERSION });
  return c.redirect(ok ? '/my/alerts?ok=resumed' : '/my/alerts?err=notfound', 303);
});

alerts.post('/:id/delete', async (c) => {
  const id = alertId(c);
  const ok = id && await deleteMyAlert(c.env.DB, { id, seekerId: c.var.user!.id });
  return c.redirect(ok ? '/my/alerts?ok=deleted' : '/my/alerts?err=notfound', 303);
});

// ── 해지 링크

export const unsubscribe = new Hono<AppEnv>();
unsubscribe.use('*', noStore);

const invalid = (c: Context<AppEnv>) => render(c, <UnsubInvalid locale={c.var.locale} />, 'alert.unsub.title', 404);

unsubscribe.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!isUnsubToken(token)) return invalid(c);
  const row = await findAlertByToken(c.env.DB, await sha256Hex(token));
  if (!row) return invalid(c);
  const ctx = await filterContext(c);
  const summary = filterSummaryText(filterSummaryItems(parseStoredFilter(row.filter_json, ctx.set), c.var.locale, ctx.set, ctx.enabled), c.var.locale, true);
  return render(c, <UnsubConfirm locale={c.var.locale} token={token} summary={summary} active={row.status === 'active'} />, 'alert.unsub.title');
});

// 확인 화면의 버튼 + RFC 8058 한 번 클릭(본문 "List-Unsubscribe=One-Click", 쿠키·Origin 없음 — 출처 검사 예외는 이 경로뿐).
unsubscribe.post('/:token', async (c) => {
  const token = c.req.param('token');
  const body = await c.req.parseBody();
  const oneClick = body['List-Unsubscribe'] === 'One-Click';
  const found = isUnsubToken(token) && await pauseAlertByToken(c.env.DB, { tokenHash: await sha256Hex(token), now: now() });
  // 메일 프로그램에는 빈 200 (Resend 안내: 200 또는 202 의 빈 응답). 모르는 토큰도 같은 응답 — 토큰이 있는지 알리지 않는다.
  if (oneClick) return c.body(null, 200, { 'Cache-Control': NO_STORE });
  if (!found) return invalid(c);
  return render(c, <UnsubDone locale={c.var.locale} all={null} />, 'alert.unsub.title');
});

unsubscribe.post('/:token/all', async (c) => {
  const token = c.req.param('token');
  if (!isUnsubToken(token)) return invalid(c);
  const hash = await sha256Hex(token);
  if (!await findAlertByToken(c.env.DB, hash)) return invalid(c);
  const n = await pauseAllByToken(c.env.DB, { tokenHash: hash, now: now() });
  return render(c, <UnsubDone locale={c.var.locale} all={n} />, 'alert.unsub.title');
});
