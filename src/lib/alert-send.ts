// 조건 알림 보내기 (T-10) — 예약 작업의 단계 sendAlerts (lib/maintenance 에 등록, 시각은 SHARED_SLOTS).
//
// 한 번 실행:
//   0) 설정 읽기 한 번: 보일 필터 + 한도·알림 켜기/끄기 (T-17, site_settings 두 키를 한 문장으로)
//   1) 정리 (sweepAlerts: 탈퇴 계정의 알림 · 12개월 안 쓴 알림(발송을 멈춘 동안은 건너뜀) · 180일 지난 해지 토큰, 각 50행)
//   2) 점검 모드이거나 한국 시간 21:00~08:00 이면 여기서 끝 (보내지 않는다 — 차례는 그대로 남아 다음 낮 실행에 나간다).
//      발송 멈춤(lib/limits.alertsPaused: 관리자가 끔 · ALERT_MAIL_SITE_DAY 0 · ALERT_SEND_PER_RUN 0)도 여기서 끝 — 알림을 읽지도 바꾸지도 않는다.
//   3) 보낼 차례가 된 알림 (오래된 차례부터, 최대 ALERT_SEND_PER_RUN = 기본 8): 켜짐 + 수신 동의 + 활동 중인 구직자 + 지금 판의 약관·방침 동의
//   4) 항목 목록 → 알림마다 실제 조건(effectiveFilter) → 새 공고 읽기 (읽기 batch 한 번)
//   5) 새 공고가 없음 · 적용되는 조건이 없음 → 메일 없이 차례만 넘긴다 (batch 한 번)
//   6) 메일 몫: 오늘 쓴 수를 읽고(ALERT_MAIL_SITE_DAY) 보낼 수만큼 **먼저** 잡는다. 몫이 모자라면 앞에서부터 그만큼만 보내고 나머지는 차례 그대로.
//   7) 한 통씩: 해지 토큰(32바이트) → 메일 → **보낸 뒤에** 기록(토큰 해시 + 확인 기준·다음 차례). 못 보내면 기록하지 않고 실패 수 + 1 (5번이면 멈춤).
// 하위 요청(D1 호출·fetch) 최대: 설정 1 + 정리 1 + 차례 1 + 항목 1 + 공고 1 + 넘기기 1 + 몫 2 + 메일마다 (Resend 1 + email_log 1 + 기록 1) = 8 + 3 × 보낸 수 (8통이면 32).
// 개인정보: 로그·집계에는 숫자만 (받는 주소·조건·id 를 남기지 않는다). 메일 본문에는 이력서·지원 기록이 없다 (lib/alerts.buildAlertMail).
import { flagsOf, type Env } from '../env';
import { OPERATOR } from '../legal/types';
import { sha256Hex, randomToken } from './crypto';
import { sendMail } from './email';
import { requiredConsents } from './consent';
import { isMaintenanceOn } from './pause';
import { buildOptionSet } from './options';
import { parseEnabledFilters, PUBLIC_FILTERS_SETTING } from './public-jobs';
import { kstDay, SCOPES, SITE } from './quota';
import { alertsPaused, resolveLimits, LIMITS_SETTING } from './limits';
import { DEFAULT_RETENTION, type RetentionValues } from './retention';
import {
  ALERT_MAX_FAILURES, ALERT_MAX_LISTED, ALERT_TOKEN_KEEP, ALERT_UNUSED_DELETE_AFTER, buildAlertMail, effectiveFilter, filterSummaryItems,
  filterSummaryText, inSendWindow, isEmptyFilter, mailsAllowed, nextDueAt, operatorLine, parseStoredFilter,
} from './alerts';
import {
  listDueAlerts, listNewJobsForAlerts, recordAlertFailure, recordAlertSent, recordAlertsSkipped, sweepAlerts, type DueAlertRow,
} from '../db/alerts';
import { listOptions } from '../db/options';
import { getSettings } from '../db/settings';
import { readUsage, takeQuota } from '../db/usage';

/** 정리 한 번에 지우는 행 수 (종류마다). */
export const ALERT_SWEEP_LIMIT = 50;

export interface AlertStepResult { step: 'sendAlerts'; done: Record<string, number> }

/** r = 이번 실행의 보관 기간 설정 (실행기가 넘긴다). 개인정보처리방침의 지금 판(rev)을 정하는 데만 쓴다. */
export async function sendAlerts(env: Env, now: number, r: RetentionValues & { rev?: number } = DEFAULT_RETENTION): Promise<AlertStepResult> {
  // 한도·알림 켜기/끄기(T-17, 관리자 설정 → 변수 → 기본값)와 보일 필터 설정을 **하위 요청 하나로** 먼저 읽는다
  // (예전에는 보일 필터를 4) 에서 따로 읽었다 — 보내는 경로의 하위 요청 수는 그대로 8 + 3n).
  const settings = await getSettings(env.DB, [PUBLIC_FILTERS_SETTING, LIMITS_SETTING]);
  const eff = resolveLimits(env, settings[LIMITS_SETTING]);
  const paused = alertsPaused(eff);
  // 발송을 멈춘 동안에는 "12개월 쓰지 않은 알림" 을 지우지 않는다 (사이트가 보내지 않아서 생긴 공백으로 구직자의 알림을 지우지 않게).
  const swept = await sweepAlerts(env.DB, {
    unusedBefore: paused ? 0 : now - ALERT_UNUSED_DELETE_AFTER, tokenBefore: now - ALERT_TOKEN_KEEP, limit: ALERT_SWEEP_LIMIT,
  });
  const done = {
    swept_deleted_users: swept.deleted_users, swept_unused: swept.unused, swept_tokens: swept.tokens,
    due: 0, sent: 0, failed: 0, auto_paused: 0, no_news: 0, no_filter: 0, quota_stopped: 0, skipped_night: 0, skipped_maintenance: 0, skipped_paused: 0,
  } satisfies Record<string, number>;
  const L = eff.values;
  const cap = L.ALERT_SEND_PER_RUN;
  if (isMaintenanceOn(env.MAINTENANCE)) { done.skipped_maintenance = 1; return { step: 'sendAlerts', done }; } // 해지 화면이 503 인 동안 보내지 않는다
  if (!inSendWindow(now)) { done.skipped_night = 1; return { step: 'sendAlerts', done }; }
  // 발송 멈춤(관리자가 끔 · 알림 메일 한도 0 · 처리 수 0): 알림을 읽지도 바꾸지도 않는다 — 차례·확인 기준·실패 수 그대로.
  // 다시 켜면 그동안 게재된 공고도 다음 메일에 들어간다 (checked_until 이 그대로이므로, 메일에는 최신 10건 + "외 N건").
  if (paused) { done.skipped_paused = 1; return { step: 'sendAlerts', done }; }

  const [terms, privacy] = requiredConsents({ rev: r.rev ?? 0 });
  const due = await listDueAlerts(env.DB, { now, termsVersion: terms!.version, privacyVersion: privacy!.version, limit: cap });
  done.due = due.length;
  if (!due.length) return { step: 'sendAlerts', done };

  const optionRows = await listOptions(env.DB);
  const setting = settings[PUBLIC_FILTERS_SETTING];
  const enabled = parseEnabledFilters(setting);
  const set = buildOptionSet(optionRows);
  // 이번에 볼 기간의 끝: 지금 - 1초 (이 초에 게재되는 공고는 다음 차례에 — 같은 공고를 두 번 보내거나 빠뜨리지 않게)
  const until = now - 1;

  type Plan = { a: DueAlertRow; stored: ReturnType<typeof parseStoredFilter>; filter: ReturnType<typeof effectiveFilter>['filter'] };
  const plans: Plan[] = [];
  const skipped: Array<{ id: string; until: number | null; nextDue: number }> = [];
  for (const a of due) {
    const stored = parseStoredFilter(a.filter_json, set);
    const { filter } = effectiveFilter(stored, enabled);
    if (isEmptyFilter(filter)) { skipped.push({ id: a.id, until: null, nextDue: nextDueAt(a.frequency, now) }); done.no_filter++; continue; }
    plans.push({ a, stored, filter });
  }
  const found = await listNewJobsForAlerts(env.DB, {
    flags: flagsOf(env), now, limit: ALERT_MAX_LISTED,
    items: plans.map((p) => ({ filter: p.filter, since: p.a.checked_until, until })),
  });
  const withNews: Array<Plan & { jobs: (typeof found)[number] }> = [];
  plans.forEach((p, i) => {
    const jobs = found[i] ?? [];
    if (jobs.length) withNews.push({ ...p, jobs });
    else { skipped.push({ id: p.a.id, until, nextDue: nextDueAt(p.a.frequency, now) }); done.no_news++; }
  });
  await recordAlertsSkipped(env.DB, skipped);
  if (!withNews.length) return { step: 'sendAlerts', done };

  // 메일 몫을 보내기 전에 잡는다. 실패한 메일도 쓴 것으로 센다 (되돌리지 않는다 — lib/quota 와 같다).
  const day = kstDay(now);
  const used = await readUsage(env.DB, { scope: SCOPES.alertMailSite, subject: SITE, day });
  const allowed = mailsAllowed(withNews.length, used, L.ALERT_MAIL_SITE_DAY);
  const taken = allowed > 0 && await takeQuota(env.DB, { scope: SCOPES.alertMailSite, subject: SITE, day, limit: L.ALERT_MAIL_SITE_DAY, ts: now, cost: allowed });
  if (!taken || allowed < withNews.length) done.quota_stopped = 1; // 나머지는 차례 그대로 (다음 실행·다음 날)
  if (!taken) return { step: 'sendAlerts', done };

  for (const p of withNews.slice(0, allowed)) {
    const locale = p.a.locale === 'zh' ? 'zh' : 'ko';
    const token = randomToken(32);
    const mail = buildAlertMail({
      locale, origin: env.APP_ORIGIN, frequency: p.a.frequency, filter: p.filter,
      summary: filterSummaryText(filterSummaryItems(p.stored, locale, set, enabled), locale),
      jobs: p.jobs, total: Math.max(p.jobs[0]?.total ?? p.jobs.length, p.jobs.length), token, set, operator: operatorLine(locale, OPERATOR),
    });
    if (await sendMail(env, { to: p.a.email, template: 'job_alert', ...mail })) {
      await recordAlertSent(env.DB, { id: p.a.id, tokenHash: await sha256Hex(token), now, until, nextDue: nextDueAt(p.a.frequency, now) });
      done.sent++;
    } else {
      done.failed++;
      if (await recordAlertFailure(env.DB, { id: p.a.id, now, max: ALERT_MAX_FAILURES })) done.auto_paused++;
    }
  }
  return { step: 'sendAlerts', done };
}
