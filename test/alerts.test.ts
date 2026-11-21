// T-10 조건 알림: 순수 함수 (lib/alerts.ts). 시간(한국 시간 09:00·월요일·야간), /jobs 파서와 같은 조건, 요약, 해지 경로, 메일.
// 모든 값은 가짜다.
import { describe, expect, it } from 'vitest';
import {
  ALERT_MAX_LISTED, ALERT_RUN_DEFAULT, ALERT_RUN_MAX, alertRunCap, buildAlertMail, effectiveFilter, filterSummaryItems, filterSummaryText, inSendWindow,
  isEmptyFilter, isOneClickUnsubscribe, isUnsubToken, isUnsubscribePath, kstHour, mailsAllowed, nextDueAt, normalizeAlertFilter, operatorLine,
  parseStoredFilter, serializeFilter, type AlertMailJob,
} from '../src/lib/alerts';
import { buildOptionSet, type OptionRow } from '../src/lib/options';
import { canonicalJobsHref, FILTER_KEYS, filterChoices, jobsHref, parseJobFilter, type FilterKey } from '../src/lib/public-jobs';
import { SHARED_SLOTS } from '../src/lib/maintenance';
import { randomToken } from '../src/lib/crypto';
import { OPERATOR } from '../src/legal/types';

const KST = 9 * 3600;
const HOUR = 3600;
/** 한국 시간 날짜·시각 → 에포크 초. */
const kst = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000 - KST;
const kstParts = (ts: number) => { const d = new Date((ts + KST) * 1000); return { dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; };

const rows: OptionRow[] = [
  { kind: 'location', code: 'seoul', label_ko: '서울', label_zh: '首尔', sort: 10, active: 1 },
  { kind: 'location', code: 'busan', label_ko: '부산', label_zh: '釜山', sort: 20, active: 1 },
  { kind: 'location', code: 'incheon', label_ko: '인천', label_zh: '仁川', sort: 30, active: 0 },
  { kind: 'role_category', code: 'sales', label_ko: '영업', label_zh: '销售', sort: 10, active: 1 },
  { kind: 'industry', code: 'battery', label_ko: '배터리', label_zh: '电池', sort: 10, active: 1 },
];
const SET = buildOptionSet(rows);
const CHOICES = filterChoices(SET);
const ALL: FilterKey[] = [...FILTER_KEYS];

describe('시간: 한국 시간 09:00 · 매주 월요일 · 야간 제한', () => {
  // 2026-11-23 은 월요일
  it('매일: after 보다 뒤의 첫 09:00 KST', () => {
    expect(nextDueAt('daily', kst(2026, 11, 21, 8, 59, 59))).toBe(kst(2026, 11, 21, 9));
    expect(nextDueAt('daily', kst(2026, 11, 21, 9))).toBe(kst(2026, 11, 22, 9));
    expect(nextDueAt('daily', kst(2026, 11, 21, 13, 5))).toBe(kst(2026, 11, 22, 9));
    expect(nextDueAt('daily', kst(2026, 11, 21, 23, 59))).toBe(kst(2026, 11, 22, 9));
    expect(nextDueAt('daily', kst(2026, 12, 31, 10))).toBe(kst(2027, 1, 1, 9));
  });
  it('매주: after 보다 뒤의 첫 월요일 09:00 KST', () => {
    expect(nextDueAt('weekly', kst(2026, 11, 23, 8))).toBe(kst(2026, 11, 23, 9));
    expect(nextDueAt('weekly', kst(2026, 11, 23, 9))).toBe(kst(2026, 11, 30, 9));
    expect(nextDueAt('weekly', kst(2026, 11, 22, 23, 30))).toBe(kst(2026, 11, 23, 9)); // 일요일 밤
    expect(nextDueAt('weekly', kst(2026, 11, 24, 0, 0, 1))).toBe(kst(2026, 11, 30, 9));
  });
  it('어느 시각에서 계산해도 결과는 09:00:00 KST (매주는 월요일), after 보다 뒤, 하루(한 주) 안', () => {
    for (let ts = kst(2026, 11, 1); ts < kst(2026, 12, 15); ts += 37 * 60 + 13) {
      const d = nextDueAt('daily', ts), w = nextDueAt('weekly', ts);
      expect(kstParts(d)).toMatchObject({ h: 9, mi: 0, s: 0 });
      expect(kstParts(w)).toMatchObject({ dow: 1, h: 9, mi: 0, s: 0 });
      expect(d).toBeGreaterThan(ts);
      expect(d - ts).toBeLessThanOrEqual(86_400);
      expect(w).toBeGreaterThan(ts);
      expect(w - ts).toBeLessThanOrEqual(7 * 86_400);
    }
  });
  it('보내는 시간: 08:00 ≤ KST < 21:00 (경계 1초)', () => {
    expect(inSendWindow(kst(2026, 11, 21, 7, 59, 59))).toBe(false);
    expect(inSendWindow(kst(2026, 11, 21, 8))).toBe(true);
    expect(inSendWindow(kst(2026, 11, 21, 20, 59, 59))).toBe(true);
    expect(inSendWindow(kst(2026, 11, 21, 21))).toBe(false);
    expect(inSendWindow(kst(2026, 11, 22, 0, 30))).toBe(false);
    expect(kstHour(kst(2026, 11, 21, 0))).toBe(0);
  });
  it('예약 작업이 알림을 보내는 UTC 시각(SHARED_SLOTS)은 모두 한국 시간 낮이고, 매일 09:00 KST 가 그중 하나', () => {
    const day = kst(2026, 11, 21) + KST - (kst(2026, 11, 21) + KST) % 86_400; // UTC 0시
    const hours = Object.keys(SHARED_SLOTS).map(Number);
    for (const h of hours) expect(inSendWindow(day + h * HOUR), `UTC ${h}`).toBe(true);
    expect(hours.map((h) => (h + 9) % 24)).toContain(9);
  });
});

describe('조건: /jobs 와 같은 파서 (다른 문법 없음)', () => {
  const queries: Record<string, string>[] = [
    { location: 'seoul' },
    { location: 'seoul', chinese_level: 'business' },
    { chinese_level: 'native', report_line: 'cn_hq', role_category: 'sales', industry: 'battery', entry_stage: 'operating', salary_basis: 'severance_excluded', location: 'busan' },
    { location: 'seoul', page: '3', lang: 'zh', x: 'y' },
    { location: 'nowhere', chinese_level: 'business' },
    { report_line: 'kr_head', chinese_level: '' },
  ];
  it('만들기 → 저장 → 다시 읽기 = /jobs 파서 결과 그대로, 이 조건의 주소 = /jobs 정규화 주소', () => {
    for (const q of queries) {
      const f = normalizeAlertFilter(q, ALL, CHOICES);
      expect(f, JSON.stringify(q)).toEqual(parseJobFilter(q, ALL, CHOICES));
      const stored = parseStoredFilter(serializeFilter(f!), SET);
      expect(stored).toEqual(f);
      const { filter, ignored } = effectiveFilter(stored, ALL);
      expect(ignored).toEqual([]);
      const canon = canonicalJobsHref({ ...q, page: undefined, lang: undefined }, ALL, CHOICES);
      expect(jobsHref(filter)).toBe(canon);
    }
  });
  it('저장 글자는 FILTER_KEYS 순서 (같은 조건 = 같은 글자 → 중복 확인)', () => {
    const a = normalizeAlertFilter({ location: 'seoul', chinese_level: 'business' }, ALL, CHOICES)!;
    const b = normalizeAlertFilter({ chinese_level: 'business', location: 'seoul' }, ALL, CHOICES)!;
    expect(serializeFilter(a)).toBe(serializeFilter(b));
    expect(serializeFilter(a)).toBe('{"chinese_level":"business","location":"seoul"}');
  });
  it('숨긴 필터·사용 종료된 항목·모르는 값은 만들 때 /jobs 와 똑같이 버려진다, 남는 조건이 없으면 null', () => {
    const enabled: FilterKey[] = ['chinese_level', 'location'];
    expect(normalizeAlertFilter({ role_category: 'sales', location: 'seoul' }, enabled, CHOICES)).toEqual({ location: 'seoul' });
    expect(normalizeAlertFilter({ location: 'incheon' }, ALL, CHOICES)).toBeNull(); // 사용 종료 → 고를 수 없음
    expect(normalizeAlertFilter({ role_category: 'sales' }, enabled, CHOICES)).toBeNull();
    expect(normalizeAlertFilter({}, ALL, CHOICES)).toBeNull();
    expect(normalizeAlertFilter({ chinese_level: 'fluent' }, ALL, CHOICES)).toBeNull();
  });
  it('저장된 값: 사용 종료된 항목은 남긴다(조건을 넓히지 않는다), 모르는 code·값·이름·깨진 JSON 은 버린다', () => {
    expect(parseStoredFilter('{"location":"incheon"}', SET)).toEqual({ location: 'incheon' });
    expect(parseStoredFilter('{"location":"mars","chinese_level":"business","evil":"1"}', SET)).toEqual({ chinese_level: 'business' });
    expect(parseStoredFilter('{"chinese_level":"x\' OR 1=1"}', SET)).toEqual({});
    for (const bad of ['', 'null', '[]', '"x"', '{', '{"location":5}']) expect(parseStoredFilter(bad, SET), bad).toEqual({});
  });
  it('보낼 때: 관리자가 숨긴 필터는 /jobs 처럼 무시(ignored), 모두 숨겨지면 빈 조건', () => {
    const stored = { chinese_level: 'business', role_category: 'sales' } as const;
    expect(effectiveFilter(stored, ['chinese_level', 'location'])).toEqual({ filter: { chinese_level: 'business' }, ignored: ['role_category'] });
    const none = effectiveFilter(stored, ['location']);
    expect(isEmptyFilter(none.filter)).toBe(true);
    expect(none.ignored).toEqual(['chinese_level', 'role_category']);
  });
});

describe('요약', () => {
  it('지금 이름으로, 사용 종료 표시, 숨긴 필터는 메일 요약에서 빠진다', () => {
    const items = filterSummaryItems({ chinese_level: 'business', role_category: 'sales', location: 'incheon' }, 'ko', SET, ['chinese_level', 'location']);
    expect(items.map((i) => [i.key, i.value, i.retired, i.ignored])).toEqual([
      ['chinese_level', '업무 가능', false, false], ['role_category', '영업', false, true], ['location', '인천', true, false],
    ]);
    expect(filterSummaryText(items, 'ko')).toBe('필요한 중국어 수준: 업무 가능 · 근무지: 인천 (사용 종료된 항목)');
    expect(filterSummaryText(items, 'ko', true)).toContain('직무: 영업');
    expect(filterSummaryText(filterSummaryItems({ location: 'seoul' }, 'zh', SET, ALL), 'zh')).toBe('工作地点：首尔');
  });
});

describe('해지 경로', () => {
  const tok = randomToken(32);
  it('토큰 모양: 32바이트 base64url = 43자', () => {
    expect(tok).toHaveLength(43);
    expect(isUnsubToken(tok)).toBe(true);
    for (const bad of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}/`, `${'a'.repeat(42)}=`]) expect(isUnsubToken(bad)).toBe(false);
  });
  it('출처 검사에서 빠지는 것은 POST /alerts/u/<토큰> 하나뿐', () => {
    expect(isOneClickUnsubscribe('POST', `/alerts/u/${tok}`)).toBe(true);
    for (const [m, p] of [
      ['GET', `/alerts/u/${tok}`], ['PUT', `/alerts/u/${tok}`], ['POST', `/alerts/u/${tok}/all`], ['POST', `/alerts/u/${tok}/`],
      ['POST', `/alerts/u/${tok}x`], ['POST', '/alerts/u/short'], ['POST', `/my/alerts`], ['POST', `/x/alerts/u/${tok}`], ['POST', `/alerts/u/${tok}?a=1`],
    ] as const) expect(isOneClickUnsubscribe(m, p), `${m} ${p}`).toBe(false);
    expect(isUnsubscribePath(`/alerts/u/${tok}`)).toBe(true);
    expect(isUnsubscribePath('/my/alerts')).toBe(false);
  });
});

describe('메일', () => {
  const jobs = (n: number): AlertMailJob[] => Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title_ko: `가짜 공고 ${i}\n줄바꿈`, company_name: i % 2 ? null : `가짜기업${i}`,
    location: i % 3 ? 'seoul' : 'incheon', closes_at: i % 2 ? null : kst(2026, 12, 31, 23, 59, 59),
  }));
  const base = { origin: 'https://recruit.example.test/', frequency: 'daily' as const, filter: { location: 'seoul' }, token: 'T'.repeat(43), set: SET, operator: null };
  it('제목 "조건에 맞는 새 공고 N건", 공고마다 제목·기업·근무지·마감·주소, 이유·관리·해지 링크, 머리글', () => {
    const m = buildAlertMail({ ...base, locale: 'ko', summary: '근무지: 서울', jobs: jobs(3), total: 3 });
    expect(m.subject).toBe('조건에 맞는 새 공고 3건');
    expect(m.text).toContain('알림 조건: 근무지: 서울');
    expect(m.text).toContain('1. 가짜 공고 0 줄바꿈');
    expect(m.text).toContain('가짜기업0 · 인천 · 마감 2026-12-31');
    expect(m.text).toContain('기업명 비공개 · 서울 · 마감 상시');
    expect(m.text).toContain('https://recruit.example.test/jobs/00000000-0000-4000-8000-000000000002');
    expect(m.text).toContain('이 메일을 받는 이유');
    expect(m.text).toContain('https://recruit.example.test/my/alerts');
    expect(m.text).toContain(`https://recruit.example.test/alerts/u/${'T'.repeat(43)}`);
    expect(m.text).not.toContain('외 ');
    expect(m.headers).toEqual({ 'List-Unsubscribe': `<https://recruit.example.test/alerts/u/${'T'.repeat(43)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(m.subject).not.toMatch(/광고/);
  });
  it('더 있으면 "외 N건" + 같은 조건의 /jobs 주소', () => {
    const m = buildAlertMail({ ...base, locale: 'ko', summary: 's', jobs: jobs(ALERT_MAX_LISTED), total: 14 });
    expect(m.subject).toBe('조건에 맞는 새 공고 14건');
    expect(m.text).toContain('외 4건: https://recruit.example.test/jobs?location=seoul');
    expect(m.text.match(/^\d+\. /gm)).toHaveLength(ALERT_MAX_LISTED);
  });
  it('중국어 메일', () => {
    const m = buildAlertMail({ ...base, locale: 'zh', summary: '工作地点：首尔', jobs: jobs(1), total: 1 });
    expect(m.subject).toBe('符合条件的新职位 1 个');
    expect(m.text).toContain('提醒条件： 工作地点：首尔');
    expect(m.text).toContain('仁川');
  });
  it('운영자 줄: 자리표시자(【확인 필요】)가 남아 있으면 넣지 않는다', () => {
    expect(operatorLine('ko', OPERATOR)).toBeNull(); // 지금은 상호가 【확인 필요】
    expect(operatorLine('ko', { name: '가짜상호', bizNo: '000-00-00000' })).toBe('운영자: 가짜상호 (사업자등록번호 000-00-00000)');
    expect(operatorLine('zh', { name: '가짜상호', bizNo: '【待确认】' })).toBeNull();
    const m = buildAlertMail({ ...base, locale: 'ko', summary: 's', jobs: jobs(1), total: 1, operator: operatorLine('ko', OPERATOR) });
    expect(m.text).not.toContain('【');
  });
  it('메일 입력에는 이력서 칸이 없다 (받는 사람의 이름·연락처·경력을 넣을 자리가 없음)', () => {
    const m = buildAlertMail({ ...base, locale: 'ko', summary: 's', jobs: jobs(2), total: 2 });
    for (const w of ['이름', '연락처', '전화', '경력', '이력서', '@']) expect(m.text, w).not.toContain(w);
  });
});

describe('한도', () => {
  it('한 번 실행의 알림 수: 기본 8, 최대 10, 0 = 끔, 잘못된 값은 기본', () => {
    expect(alertRunCap(undefined)).toBe(ALERT_RUN_DEFAULT);
    expect(alertRunCap('3')).toBe(3);
    expect(alertRunCap('20')).toBe(ALERT_RUN_MAX);
    expect(alertRunCap('0')).toBe(0);
    expect(alertRunCap('abc')).toBe(ALERT_RUN_DEFAULT);
  });
  it('보낼 수 있는 메일 수 = min(보낼 알림, 한도 - 오늘 쓴 수), 음수 없음', () => {
    expect(mailsAllowed(5, 0, 40)).toBe(5);
    expect(mailsAllowed(5, 37, 40)).toBe(3);
    expect(mailsAllowed(5, 40, 40)).toBe(0);
    expect(mailsAllowed(5, 45, 40)).toBe(0);
  });
});
