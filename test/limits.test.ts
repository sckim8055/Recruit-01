// T-17 사용량 한도·조건 알림 켜기/끄기: 관리자 설정 → 설정 파일 → 기본값, 범위(저장·읽기 모두), 기업 ≤ 사이트, 저장 계획, 몫 잡기에 바로 반영.
// 순수 함수 + SQLite 메모리 DB(lib/quota). 모든 값은 가짜다.
import { describe, expect, it } from 'vitest';
import {
  alertsPaused, appendLimitsLog, LIMIT_KEYS, LIMIT_SPEC, LIMITS_LOG_MAX, LIMITS_SETTING, limitSpecOf, mailPlanWarning, parseLimitsLog, parseStoredLimits,
  planAlertsSave, planLimitsSave, readLimitsForm, resolveLimits, serializeStoredLimits, validateLimitsForm, type LimitKey, type LimitValues,
} from '../src/lib/limits';
import { DEFAULT_LIMITS, kstDay, limitsOf, loadLimits, SCOPES, SITE, takeAdminLocalizeTest, takeCompanyMail, takeLocalize, todayUsage } from '../src/lib/quota';
import { ALERT_RUN_DEFAULT, ALERT_RUN_MAX } from '../src/lib/alerts';
import { readUsage } from '../src/db/usage';
import { hasSqlite, migratedDb } from './sqlite-d1';

const admin = (values: Partial<Record<LimitKey, unknown>>, extra: Record<string, unknown> = {}) => JSON.stringify({ values, ...extra });
const DEFAULTS: LimitValues = { ...DEFAULT_LIMITS, ALERT_SEND_PER_RUN: ALERT_RUN_DEFAULT };
/** 각 칸에서 범위 안이고 기본값·설정 파일 값과 다른 두 값 (관리자 값, 설정 파일 값). */
const pick = (k: LimitKey): [number, number] => {
  const s = limitSpecOf(k);
  const not = (n: number) => (n === s.default ? n + 1 : n);
  return [not(s.min + 1), not(s.min + 3)];
};

describe('lib/limits: 관리자 설정 → 설정 파일 → 기본값', () => {
  it('아무것도 없으면 모두 기본값, 알림은 켜짐', () => {
    const e = resolveLimits({}, null);
    expect(e.values).toEqual(DEFAULTS);
    expect(e.alertsEnabled).toBe(true);
    for (const k of LIMIT_KEYS) expect(e.source[k]).toBe('default');
    expect(e.source.alerts_enabled).toBe('default');
  });

  for (const k of LIMIT_KEYS) {
    it(`${k}: 관리자 > 설정 파일 > 기본값`, () => {
      const [a, v] = pick(k);
      expect(a).not.toBe(v);
      // 기본값만
      expect(resolveLimits({}, admin({}))).toMatchObject({ values: { [k]: DEFAULTS[k] }, source: { [k]: 'default' } });
      // 설정 파일
      const env = { [k]: String(v) };
      expect(resolveLimits(env, null)).toMatchObject({ values: { [k]: v }, source: { [k]: 'env' }, envValues: { [k]: v } });
      // 관리자 설정이 이긴다
      expect(resolveLimits(env, admin({ [k]: a }))).toMatchObject({ values: { [k]: a }, source: { [k]: 'admin' }, envValues: { [k]: v } });
      // 다른 칸은 영향 없음
      const other = LIMIT_KEYS.find((x) => x !== k)!;
      expect(resolveLimits(env, admin({ [k]: a })).source[other]).toBe('default');
    });

    it(`${k}: DB 의 범위 밖·정수 아님·문자열 값은 무시 → 설정 파일 → 기본값`, () => {
      const s = limitSpecOf(k);
      const [, v] = pick(k);
      for (const bad of [s.max + 1, s.min - 1, 1.5, String(s.default), null, -1]) {
        expect(resolveLimits({}, admin({ [k]: bad })), String(bad)).toMatchObject({ values: { [k]: DEFAULTS[k] }, source: { [k]: 'default' } });
        expect(resolveLimits({ [k]: String(v) }, admin({ [k]: bad })), String(bad)).toMatchObject({ values: { [k]: v }, source: { [k]: 'env' } });
      }
    });
  }

  it('깨진 JSON·배열·모양이 다른 값은 빈 설정', () => {
    for (const raw of ['{', '[]', '"x"', '{"values":[1,2]}', '{"values":{"MAIL_SITE_DAY":"10"}}', '{"alerts_enabled":"no"}']) {
      const e = resolveLimits({}, raw);
      expect(e.values, raw).toEqual(DEFAULTS);
      expect(e.alertsEnabled, raw).toBe(true);
    }
  });

  it('설정 파일 값은 예전 규칙 그대로 (0~1,000,000, 처리 수는 최대 10으로 줄임)', () => {
    expect(resolveLimits({ MAIL_SITE_DAY: '60000' }, null).values.MAIL_SITE_DAY).toBe(60000); // 화면 범위(5000)는 화면 입력에만
    expect(resolveLimits({ MAIL_SITE_DAY: 'abc' }, null).source.MAIL_SITE_DAY).toBe('default');
    expect(resolveLimits({ ALERT_SEND_PER_RUN: '20' }, null).values.ALERT_SEND_PER_RUN).toBe(ALERT_RUN_MAX);
    expect(resolveLimits({ DRAFT_JOBS_PER_COMPANY: '0' }, null).values.DRAFT_JOBS_PER_COMPANY).toBe(0);
    // limitsOf(변수 → 기본값)는 예전과 같다
    expect(limitsOf({ MAIL_SITE_DAY: '7' }).MAIL_SITE_DAY).toBe(7);
  });

  it('알림 켜기/끄기: 관리자 설정 → 기본값(켜짐)', () => {
    expect(resolveLimits({}, admin({}, { alerts_enabled: false }))).toMatchObject({ alertsEnabled: false, source: { alerts_enabled: 'admin' } });
    expect(resolveLimits({}, admin({}, { alerts_enabled: true }))).toMatchObject({ alertsEnabled: true, source: { alerts_enabled: 'admin' } });
  });

  it('발송 멈춤 = 꺼짐 · 알림 메일 한도 0 · 처리 수 0 (하나의 상태)', () => {
    expect(alertsPaused(resolveLimits({}, null))).toBe(false);
    expect(alertsPaused(resolveLimits({}, admin({}, { alerts_enabled: false })))).toBe(true);
    expect(alertsPaused(resolveLimits({ ALERT_MAIL_SITE_DAY: '0' }, null))).toBe(true);
    expect(alertsPaused(resolveLimits({}, admin({ ALERT_MAIL_SITE_DAY: 0 })))).toBe(true);
    expect(alertsPaused(resolveLimits({}, admin({ ALERT_SEND_PER_RUN: 0 })))).toBe(true);
  });

  it('무료 플랜 경고: 기업 메일 + 알림 메일 > 70 (기본값이면 경고)', () => {
    expect(mailPlanWarning({ MAIL_SITE_DAY: 40, ALERT_MAIL_SITE_DAY: 30 })).toBe(false);
    expect(mailPlanWarning({ MAIL_SITE_DAY: 41, ALERT_MAIL_SITE_DAY: 30 })).toBe(true);
    expect(mailPlanWarning(DEFAULTS)).toBe(true);
  });

  it('범위: 처리 수 최대 10, 알림 메일 100, 초안 1~100, 사이트 5000', () => {
    const r = Object.fromEntries(LIMIT_SPEC.map((s) => [s.key, [s.min, s.max]]));
    expect(r).toEqual({
      LOCALIZE_SITE_DAY: [0, 5000], LOCALIZE_PER_COMPANY_DAY: [0, 5000], ADMIN_LOCALIZE_TEST_DAY: [0, 1000], MAIL_SITE_DAY: [0, 5000],
      MAIL_PER_COMPANY_DAY: [0, 5000], DRAFT_JOBS_PER_COMPANY: [1, 100], ALERT_MAIL_SITE_DAY: [0, 100], ALERT_SEND_PER_RUN: [0, 10],
    });
    for (const s of LIMIT_SPEC) expect(s.default >= s.min && s.default <= s.max, s.key).toBe(true);
  });
});

const formOf = (v: Partial<Record<LimitKey, string>> = {}) => readLimitsForm({ ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(DEFAULTS[k])])), ...v });

describe('lib/limits: 폼 검사', () => {
  it('기본값 폼은 통과', () => expect(validateLimitsForm(formOf())).toEqual({ ok: true, value: DEFAULTS }));

  it('정수 아님·범위 밖', () => {
    const r = validateLimitsForm(formOf({ MAIL_SITE_DAY: '5001', ALERT_SEND_PER_RUN: '11', DRAFT_JOBS_PER_COMPANY: '0', ALERT_MAIL_SITE_DAY: '101', LOCALIZE_SITE_DAY: '1.5', ADMIN_LOCALIZE_TEST_DAY: '' }));
    expect(r).toEqual({ ok: false, errors: {
      MAIL_SITE_DAY: 'out_of_range', ALERT_SEND_PER_RUN: 'out_of_range', DRAFT_JOBS_PER_COMPANY: 'out_of_range', ALERT_MAIL_SITE_DAY: 'out_of_range',
      LOCALIZE_SITE_DAY: 'not_integer', ADMIN_LOCALIZE_TEST_DAY: 'not_integer',
    } });
  });

  it('기업·관리자 몫은 사이트 몫보다 클 수 없다 (같으면 됨)', () => {
    expect(validateLimitsForm(formOf({ MAIL_SITE_DAY: '50', MAIL_PER_COMPANY_DAY: '51' }))).toEqual({ ok: false, errors: { MAIL_PER_COMPANY_DAY: 'over_site' } });
    expect(validateLimitsForm(formOf({ MAIL_SITE_DAY: '50', MAIL_PER_COMPANY_DAY: '50' })).ok).toBe(true);
    expect(validateLimitsForm(formOf({ LOCALIZE_SITE_DAY: '10', LOCALIZE_PER_COMPANY_DAY: '30', ADMIN_LOCALIZE_TEST_DAY: '11' })))
      .toEqual({ ok: false, errors: { LOCALIZE_PER_COMPANY_DAY: 'over_site', ADMIN_LOCALIZE_TEST_DAY: 'over_site' } });
  });
});

describe('lib/limits: 저장 계획', () => {
  it('바꾼 칸만 관리자 값이 되고 나머지는 설정 파일·기본값을 계속 따른다', () => {
    const env = { MAIL_SITE_DAY: '60' };
    const cur = parseStoredLimits(null);
    const next = { ...DEFAULTS, MAIL_SITE_DAY: 60, MAIL_PER_COMPANY_DAY: 20 };
    const p = planLimitsSave(env, cur, next);
    expect(p.stored.values).toEqual({ MAIL_PER_COMPANY_DAY: 20 });
    expect(p.changes).toEqual([{ key: 'MAIL_PER_COMPANY_DAY', from: 100, to: 20 }]);
    expect(p.after.source).toMatchObject({ MAIL_SITE_DAY: 'env', MAIL_PER_COMPANY_DAY: 'admin', LOCALIZE_SITE_DAY: 'default' });
    // 이미 관리자 값인 칸은 같은 값이어도 관리자 값으로 남는다
    const p2 = planLimitsSave(env, p.stored, { ...next });
    expect(p2.stored.values).toEqual({ MAIL_PER_COMPANY_DAY: 20 });
    expect(p2.changes).toEqual([]);
  });

  it('기본값으로 되돌리기는 한도 칸만 지우고 알림 켜기/끄기는 둔다', () => {
    const cur = parseStoredLimits(admin({ MAIL_SITE_DAY: 50, ALERT_SEND_PER_RUN: 3 }, { alerts_enabled: false }));
    const p = planLimitsSave({ ALERT_SEND_PER_RUN: '5' }, cur, 'reset');
    expect(p.stored).toEqual({ values: {}, alerts_enabled: false });
    expect(p.changes).toEqual([{ key: 'MAIL_SITE_DAY', from: 50, to: 1000 }, { key: 'ALERT_SEND_PER_RUN', from: 3, to: 5 }]);
    const a = planAlertsSave({}, cur, 'reset');
    expect(a.stored).toEqual({ values: { MAIL_SITE_DAY: 50, ALERT_SEND_PER_RUN: 3 } });
    expect(a.changes).toEqual([{ key: 'alerts_enabled', from: 0, to: 1 }]);
  });

  it('알림: 지금과 같은 값(기본값 켜짐)을 고르면 저장할 것이 없다', () => {
    const cur = parseStoredLimits(null);
    expect(serializeStoredLimits(planAlertsSave({}, cur, true).stored)).toBe(serializeStoredLimits(cur));
    expect(planAlertsSave({}, cur, false)).toMatchObject({ stored: { alerts_enabled: false }, changes: [{ key: 'alerts_enabled', from: 1, to: 0 }] });
  });

  it('변경 기록은 최근 20줄, 깨진 값이면 새로 시작', () => {
    let raw: string | null = '{bad';
    for (let i = 0; i < LIMITS_LOG_MAX + 3; i++) raw = appendLimitsLog(raw, { at: i, by: 'adm', changes: [] });
    const log = parseLimitsLog(raw);
    expect(log).toHaveLength(LIMITS_LOG_MAX);
    expect(log[0]!.at).toBe(3);
  });
});

describe.skipIf(!hasSqlite)('lib/quota: 관리자 설정이 몫 잡기에 바로 반영된다 (다시 배포 없음)', () => {
  const TS = Date.UTC(2027, 0, 15, 3, 0, 0) / 1000;
  const setLimits = (raw: ReturnType<typeof migratedDb>['raw'], json: string) =>
    raw.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,NULL,0)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(LIMITS_SETTING, json);

  it('사용량보다 낮추면 거절, 다시 올리면 바로 허용 — 오늘 센 수는 그대로', async () => {
    const { raw, d1 } = migratedDb();
    const env = { DB: d1, LOCALIZE_PER_COMPANY_DAY: '30' };
    for (let i = 0; i < 3; i++) expect((await takeLocalize(env, 'co-1', TS)).ok).toBe(true);
    setLimits(raw, admin({ LOCALIZE_PER_COMPANY_DAY: 2 })); // 이미 3 을 썼다
    expect(await takeLocalize(env, 'co-1', TS)).toEqual({ ok: false, pool: 'company', limit: 2 });
    expect(await readUsage(d1, { scope: SCOPES.localizeCompany, subject: 'co-1', day: kstDay(TS) })).toBe(3); // 되돌리지 않음
    setLimits(raw, admin({ LOCALIZE_PER_COMPANY_DAY: 5 }));
    expect((await takeLocalize(env, 'co-1', TS)).ok).toBe(true);
    expect(await readUsage(d1, { scope: SCOPES.localizeCompany, subject: 'co-1', day: kstDay(TS) })).toBe(4);
    // 한국 시간 다음 날 0시 → 새로 센다
    setLimits(raw, admin({ LOCALIZE_PER_COMPANY_DAY: 1 }));
    expect((await takeLocalize(env, 'co-1', TS)).ok).toBe(false);
    const nextKstMidnight = Math.floor((TS + 9 * 3600) / 86400 + 1) * 86400 - 9 * 3600;
    expect((await takeLocalize(env, 'co-1', nextKstMidnight - 1)).ok).toBe(false);
    expect((await takeLocalize(env, 'co-1', nextKstMidnight)).ok).toBe(true);
  });

  it('사이트 몫·메일·관리자 비교에도 같은 순서 (관리자 > 변수 > 기본값), todayUsage 도 지금 값', async () => {
    const { raw, d1 } = migratedDb();
    const env = { DB: d1, MAIL_SITE_DAY: '3', ADMIN_LOCALIZE_TEST_DAY: '9' };
    expect((await todayUsage(env, TS)).mail.limit).toBe(3);
    setLimits(raw, admin({ MAIL_SITE_DAY: 1, ADMIN_LOCALIZE_TEST_DAY: 2 }));
    expect((await takeCompanyMail(env, 'co-1', TS)).ok).toBe(true);
    expect(await takeCompanyMail(env, 'co-2', TS)).toEqual({ ok: false, pool: 'site', limit: 1 });
    expect(await takeAdminLocalizeTest(env, 'adm', TS, 3)).toEqual({ ok: false, pool: 'admin', limit: 2 });
    expect((await todayUsage(env, TS)).mail).toEqual({ n: 1, limit: 1 });
    // 범위 밖 값이 DB 에 있으면 무시 → 변수
    setLimits(raw, admin({ MAIL_SITE_DAY: 999999 }));
    expect((await loadLimits(env)).values.MAIL_SITE_DAY).toBe(3);
    expect(await readUsage(d1, { scope: SCOPES.mailSite, subject: SITE, day: kstDay(TS) })).toBe(1);
  });

  it('미리 읽은 한도를 넘기면 설정을 다시 읽지 않는다 (불합격 묶음)', async () => {
    const { d1 } = migratedDb();
    let reads = 0;
    const db = { prepare: (sql: string) => { if (sql.includes('site_settings')) reads++; return d1.prepare(sql); }, batch: (s: never) => d1.batch(s) } as unknown as D1Database;
    const L = { ...DEFAULT_LIMITS };
    for (let i = 0; i < 3; i++) await takeCompanyMail({ DB: db }, 'co-1', TS, L);
    expect(reads).toBe(0);
    await takeCompanyMail({ DB: db }, 'co-1', TS);
    expect(reads).toBe(1);
  });
});
