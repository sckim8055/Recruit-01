// 남용 방지 한도 (T-05c): 한국 시간 날짜, 변수 해석, takeQuota(한 문장 가드) — SQLite 메모리 DB.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIMIT_MAX, LIMIT_NAMES, SCOPES, SITE, kstDay, limitsOf, parseLimit, takeAdminLocalizeTest, takeCompanyMail, takeLocalize, todayUsage } from '../src/lib/quota';
import { readUsage, takeQuota } from '../src/db/usage';
import { hasSqlite, migratedDb } from './sqlite-d1';

describe('kstDay (한국 시간 0시에 날짜가 바뀐다)', () => {
  // 2027-01-14 15:00:00 UTC = 2027-01-15 00:00:00 KST
  const MIDNIGHT_KST = Date.UTC(2027, 0, 14, 15, 0, 0) / 1000;
  it('자정 1초 전·정각·1초 뒤', () => {
    expect(kstDay(MIDNIGHT_KST - 1)).toBe('2027-01-14');
    expect(kstDay(MIDNIGHT_KST)).toBe('2027-01-15');
    expect(kstDay(MIDNIGHT_KST + 1)).toBe('2027-01-15');
  });
  it('UTC 날짜와 다른 시간대 (UTC 15시~24시는 한국에서 다음 날)', () => {
    expect(kstDay(Date.UTC(2027, 0, 14, 14, 59, 59) / 1000)).toBe('2027-01-14');
    expect(kstDay(Date.UTC(2027, 0, 14, 23, 0, 0) / 1000)).toBe('2027-01-15');
    expect(kstDay(Date.UTC(2027, 0, 15, 0, 0, 0) / 1000)).toBe('2027-01-15');
  });
  it('해·달 경계', () => {
    expect(kstDay(Date.UTC(2026, 11, 31, 14, 59, 59) / 1000)).toBe('2026-12-31');
    expect(kstDay(Date.UTC(2026, 11, 31, 15, 0, 0) / 1000)).toBe('2027-01-01');
    expect(kstDay(Date.UTC(2028, 1, 28, 15, 0, 0) / 1000)).toBe('2028-02-29');
  });
});

describe('limitsOf / parseLimit', () => {
  it('변수가 없으면 기본값 (브리프의 숫자)', () => {
    expect(limitsOf({})).toEqual({
      LOCALIZE_PER_COMPANY_DAY: 30, LOCALIZE_SITE_DAY: 500, ADMIN_LOCALIZE_TEST_DAY: 50, MAIL_PER_COMPANY_DAY: 100, MAIL_SITE_DAY: 1000, DRAFT_JOBS_PER_COMPANY: 20, ALERT_MAIL_SITE_DAY: 40,
    });
    expect(limitsOf({})).toEqual(DEFAULT_LIMITS);
  });
  it('정수 문자열이면 그 값 (앞뒤 공백 허용, 0 은 "쓰지 않음")', () => {
    expect(limitsOf({ LOCALIZE_PER_COMPANY_DAY: '2', MAIL_SITE_DAY: ' 7 ', DRAFT_JOBS_PER_COMPANY: '0' }))
      .toMatchObject({ LOCALIZE_PER_COMPANY_DAY: 2, MAIL_SITE_DAY: 7, DRAFT_JOBS_PER_COMPANY: 0, LOCALIZE_SITE_DAY: 500 });
    expect(parseLimit(String(LIMIT_MAX), 5)).toBe(LIMIT_MAX);
  });
  it('잘못된 값은 기본값', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1.5', '1e3', '0x10', '10abc', '+3', String(LIMIT_MAX + 1), '99999999', 'Infinity', 'NaN']) {
      expect(parseLimit(bad, 9), bad).toBe(9);
    }
    expect(parseLimit(undefined, 9)).toBe(9);
    expect(parseLimit(12 as unknown, 9)).toBe(9);
    for (const k of LIMIT_NAMES) expect(limitsOf({ [k]: 'garbage' })[k]).toBe(DEFAULT_LIMITS[k]);
  });
});

describe.skipIf(!hasSqlite)('takeQuota (한 문장 가드)', () => {
  const day = '2027-01-15';
  const key = { scope: 'localize_company', subject: 'co-1', day };

  it('한도까지 세고 그다음은 거절, 값은 한도를 넘지 않는다', async () => {
    const { d1 } = migratedDb();
    const got: boolean[] = [];
    for (let i = 0; i < 5; i++) got.push(await takeQuota(d1, { ...key, limit: 3, ts: 100 + i }));
    expect(got).toEqual([true, true, true, false, false]);
    expect(await readUsage(d1, key)).toBe(3);
  });

  it('범위·대상·날짜가 다르면 따로 센다', async () => {
    const { d1, raw } = migratedDb();
    expect(await takeQuota(d1, { ...key, limit: 1, ts: 1 })).toBe(true);
    expect(await takeQuota(d1, { ...key, limit: 1, ts: 1 })).toBe(false);
    expect(await takeQuota(d1, { ...key, scope: 'mail_company', limit: 1, ts: 1 })).toBe(true);
    expect(await takeQuota(d1, { ...key, subject: 'co-2', limit: 1, ts: 1 })).toBe(true);
    expect(await takeQuota(d1, { ...key, day: '2027-01-16', limit: 1, ts: 1 })).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM usage_counters').get()!.n).toBe(4);
    expect(await readUsage(d1, { ...key, subject: 'nobody' })).toBe(0);
  });

  it('cost > 1: 남은 몫보다 크면 아무것도 바꾸지 않는다', async () => {
    const { d1 } = migratedDb();
    expect(await takeQuota(d1, { ...key, limit: 5, ts: 1, cost: 6 })).toBe(false); // 첫 사용에서도 넘으면 행을 만들지 않는다
    expect(await readUsage(d1, key)).toBe(0);
    expect(await takeQuota(d1, { ...key, limit: 5, ts: 1, cost: 3 })).toBe(true);
    expect(await takeQuota(d1, { ...key, limit: 5, ts: 2, cost: 3 })).toBe(false);
    expect(await readUsage(d1, key)).toBe(3);
    expect(await takeQuota(d1, { ...key, limit: 5, ts: 3, cost: 2 })).toBe(true);
    expect(await readUsage(d1, key)).toBe(5);
    expect(await takeQuota(d1, { ...key, limit: 5, ts: 4 })).toBe(false);
  });

  it('한도 0 은 처음부터 거절', async () => {
    const { d1 } = migratedDb();
    expect(await takeQuota(d1, { ...key, limit: 0, ts: 1 })).toBe(false);
    expect(await readUsage(d1, key)).toBe(0);
  });

  it('동시에 여러 번: 정확히 limit 개만 성공 (한도 - 1 에서 두 요청 → 하나만)', async () => {
    const { d1 } = migratedDb();
    const all = await Promise.all(Array.from({ length: 25 }, (_, i) => takeQuota(d1, { ...key, limit: 10, ts: i })));
    expect(all.filter(Boolean).length).toBe(10);
    expect(await readUsage(d1, key)).toBe(10);
    const k2 = { ...key, subject: 'co-edge' };
    for (let i = 0; i < 4; i++) await takeQuota(d1, { ...k2, limit: 5, ts: i });
    const pair = await Promise.all([takeQuota(d1, { ...k2, limit: 5, ts: 9 }), takeQuota(d1, { ...k2, limit: 5, ts: 9 })]);
    expect(pair.filter(Boolean).length).toBe(1);
    expect(await readUsage(d1, k2)).toBe(5);
  });

  it('updated_at 은 마지막으로 센 시각, 거절은 바꾸지 않는다', async () => {
    const { d1, raw } = migratedDb();
    await takeQuota(d1, { ...key, limit: 2, ts: 10 });
    await takeQuota(d1, { ...key, limit: 2, ts: 20 });
    await takeQuota(d1, { ...key, limit: 2, ts: 30 });
    expect(raw.prepare('SELECT n, updated_at FROM usage_counters').get()).toMatchObject({ n: 2, updated_at: 20 });
  });
});

describe.skipIf(!hasSqlite)('lib/quota: 기업 몫 → 사이트 몫', () => {
  const TS = Date.UTC(2027, 0, 15, 3, 0, 0) / 1000;
  const envOf = (d1: D1Database, v: Record<string, string> = {}) => ({ DB: d1, ...v });

  it('기업 몫이 먼저 거절되면 사이트 몫은 건드리지 않는다', async () => {
    const { d1 } = migratedDb();
    const env = envOf(d1, { LOCALIZE_PER_COMPANY_DAY: '1' });
    expect(await takeLocalize(env, 'co-1', TS)).toEqual({ ok: true });
    expect(await takeLocalize(env, 'co-1', TS)).toEqual({ ok: false, pool: 'company', limit: 1 });
    expect(await readUsage(d1, { scope: SCOPES.localizeSite, subject: SITE, day: kstDay(TS) })).toBe(1);
  });

  it('사이트 몫이 거절되면 기업 몫은 쓴 것으로 남는다 (되돌리지 않음)', async () => {
    const { d1 } = migratedDb();
    const env = envOf(d1, { LOCALIZE_SITE_DAY: '1' });
    expect((await takeLocalize(env, 'co-1', TS)).ok).toBe(true);
    expect(await takeLocalize(env, 'co-2', TS)).toEqual({ ok: false, pool: 'site', limit: 1 });
    expect(await readUsage(d1, { scope: SCOPES.localizeCompany, subject: 'co-2', day: kstDay(TS) })).toBe(1);
  });

  it('관리자 엔진 비교는 엔진 수만큼, 사이트 번역 몫도 같이 쓴다', async () => {
    const { d1 } = migratedDb();
    const env = envOf(d1, { ADMIN_LOCALIZE_TEST_DAY: '4' });
    expect((await takeAdminLocalizeTest(env, 'adm', TS, 3)).ok).toBe(true);
    expect(await takeAdminLocalizeTest(env, 'adm', TS, 2)).toEqual({ ok: false, pool: 'admin', limit: 4 });
    expect((await takeAdminLocalizeTest(env, 'adm', TS, 1)).ok).toBe(true);
    expect(await todayUsage(env, TS)).toEqual({ day: '2027-01-15', localize: { n: 4, limit: 500 }, mail: { n: 0, limit: 1000 } });
  });

  it('메일 몫은 번역 몫과 따로', async () => {
    const { d1 } = migratedDb();
    const env = envOf(d1, { MAIL_PER_COMPANY_DAY: '2', LOCALIZE_PER_COMPANY_DAY: '1' });
    expect((await takeCompanyMail(env, 'co-1', TS)).ok).toBe(true);
    expect((await takeLocalize(env, 'co-1', TS)).ok).toBe(true);
    expect((await takeCompanyMail(env, 'co-1', TS)).ok).toBe(true);
    expect(await takeCompanyMail(env, 'co-1', TS)).toEqual({ ok: false, pool: 'company', limit: 2 });
    // 한국 시간 다음 날이면 다시 0 부터
    expect((await takeCompanyMail(env, 'co-1', TS + 86400)).ok).toBe(true);
    expect((await todayUsage(env, TS)).mail).toEqual({ n: 2, limit: 1000 });
  });
});
