// T-12c 보관 기간 설정: 해석(기본값·범위·잘못된 값)·폼 검사·저장 계획(rev)·변경 기록, 방침·동의 문구 채우기(renderLegal), 개인정보 판.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION, RETENTION_LOG_MAX, RETENTION_SPEC, appendRetentionLog, formFromRetention, inRange, parseRetention, parseRetentionLog,
  planRetentionSave, readRetentionForm, retentionSeconds, serializeRetention, validateRetentionForm, DAY,
  APPLICATION_KEEP_AFTER_CLOSE, APPLICATION_AUTO_CLOSE_AFTER, VDOC_KEEP_AFTER_REVIEW, ACCESS_LOG_KEEP, JOB_STALE_AFTER,
} from '../src/lib/retention';
import { PRIVACY } from '../src/legal/privacy';
import { TERMS } from '../src/legal/terms';
import { RETENTION_TEXT_KEYS, fillLegal, legalParams, renderLegal, tRetention } from '../src/legal/render';
import { LEGAL_PARAMS } from '../src/legal/types';
import { PRIVACY_VERSION, TERMS_VERSION, missingConsents, privacyVersion, requiredConsents } from '../src/lib/consent';
import { crossBorderVersion, CROSS_BORDER_VERSION } from '../src/lib/application';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';

const R = (p: Partial<typeof DEFAULT_RETENTION> = {}) => ({ ...DEFAULT_RETENTION, ...p });

describe('parseRetention', () => {
  it('없음·빈 값·JSON 아님·배열 → 기본값 (= T-12 상수)', () => {
    for (const raw of [null, '', 'nope', '[1,2]', '"x"', '42', 'null']) expect(parseRetention(raw)).toEqual(DEFAULT_RETENTION);
    expect(DEFAULT_RETENTION).toEqual({
      application_keep_days: 180, application_auto_close_days: 30, vdoc_keep_days: 365, access_log_keep_days: 730, job_stale_days: 30, rev: 0,
    });
    // 기본값은 T-12 의 상수와 같은 숫자다
    expect(DEFAULT_RETENTION.application_keep_days * DAY).toBe(APPLICATION_KEEP_AFTER_CLOSE);
    expect(DEFAULT_RETENTION.application_auto_close_days * DAY).toBe(APPLICATION_AUTO_CLOSE_AFTER);
    expect(DEFAULT_RETENTION.vdoc_keep_days * DAY).toBe(VDOC_KEEP_AFTER_REVIEW);
    expect(DEFAULT_RETENTION.access_log_keep_days * DAY).toBe(ACCESS_LOG_KEEP);
    expect(DEFAULT_RETENTION.job_stale_days * DAY).toBe(JOB_STALE_AFTER);
  });
  it('일부만 있는 JSON: 있는 칸만 쓰고 나머지는 기본값', () => {
    expect(parseRetention('{"application_keep_days":90}')).toEqual(R({ application_keep_days: 90 }));
    expect(parseRetention('{"job_stale_days":0,"rev":2}')).toEqual(R({ job_stale_days: 0, rev: 2 }));
  });
  it('범위 경계: min·max 는 받고, 1 벗어나면 그 칸만 기본값 (한도 없는 값으로 가지 않는다)', () => {
    for (const s of RETENTION_SPEC) {
      expect(parseRetention(JSON.stringify({ [s.key]: s.min }))[s.key], `${s.key} min`).toBe(s.min);
      expect(parseRetention(JSON.stringify({ [s.key]: s.max }))[s.key], `${s.key} max`).toBe(s.max);
      expect(parseRetention(JSON.stringify({ [s.key]: s.min - 1 }))[s.key], `${s.key} min-1`).toBe(s.offAllowed && s.min - 1 === 0 ? 0 : s.default);
      expect(parseRetention(JSON.stringify({ [s.key]: s.max + 1 }))[s.key], `${s.key} max+1`).toBe(s.default);
    }
  });
  it('잘못된 값: 정수 아님·문자열·음수·0(끌 수 없는 칸)·아주 큰 수·null → 그 칸의 기본값', () => {
    const bad = [90.5, '90', -1, 0, 1e12, null, true, {}, [], Number.NaN];
    for (const v of bad) {
      const r = parseRetention(JSON.stringify({ application_keep_days: v, vdoc_keep_days: v, access_log_keep_days: v }));
      expect(r.application_keep_days).toBe(180);
      expect(r.vdoc_keep_days).toBe(365);
      expect(r.access_log_keep_days).toBe(730);
    }
    expect(parseRetention('{"job_stale_days":13}').job_stale_days).toBe(30); // 0 과 14 사이는 안 됨
    expect(parseRetention('{"rev":-1}').rev).toBe(0);
    expect(parseRetention('{"rev":1.5}').rev).toBe(0);
    expect(parseRetention('{"rev":"3"}').rev).toBe(0);
  });
  it('자동 종료 ≥ 보관 기간이면 자동 종료를 min(기본값, 보관 - 1) 로 줄인다', () => {
    expect(parseRetention('{"application_keep_days":30,"application_auto_close_days":30}').application_auto_close_days).toBe(29);
    expect(parseRetention('{"application_keep_days":60,"application_auto_close_days":90}').application_auto_close_days).toBe(30);
    expect(parseRetention('{"application_keep_days":60,"application_auto_close_days":59}').application_auto_close_days).toBe(59);
  });
  it('serialize → parse 가 같다', () => {
    const r = R({ application_keep_days: 90, job_stale_days: 0, rev: 3 });
    expect(parseRetention(serializeRetention(r))).toEqual(r);
  });
});

describe('관리자 폼 검사', () => {
  const form = (p: Record<string, string> = {}) => readRetentionForm({
    application_keep_days: '180', application_auto_close_days: '30', vdoc_keep_days: '365', access_log_keep_days: '730', job_stale_days: '30', ...p,
  });
  it('기본값은 통과, 칸마다 오류', () => {
    const { rev: _rev, ...values } = DEFAULT_RETENTION;
    expect(validateRetentionForm(form())).toEqual({ ok: true, value: values });
    const v = validateRetentionForm(form({ application_keep_days: '29', vdoc_keep_days: 'x', access_log_keep_days: '1826', job_stale_days: '7' }));
    expect(v).toEqual({ ok: false, errors: { application_keep_days: 'out_of_range', vdoc_keep_days: 'not_integer', access_log_keep_days: 'out_of_range', job_stale_days: 'out_of_range' } });
    expect(validateRetentionForm(form({ application_keep_days: '90.5' }))).toMatchObject({ ok: false, errors: { application_keep_days: 'not_integer' } });
    expect(validateRetentionForm(form({ application_keep_days: '' }))).toMatchObject({ ok: false, errors: { application_keep_days: 'not_integer' } });
    expect(validateRetentionForm(form({ application_keep_days: '-5' }))).toMatchObject({ ok: false, errors: { application_keep_days: 'not_integer' } });
  });
  it('자동 종료 ≥ 보관 기간은 거절', () => {
    expect(validateRetentionForm(form({ application_keep_days: '30', application_auto_close_days: '30' })))
      .toEqual({ ok: false, errors: { application_auto_close_days: 'auto_close_not_shorter' } });
    expect(validateRetentionForm(form({ application_keep_days: '60', application_auto_close_days: '59' }))).toMatchObject({ ok: true });
  });
  it('공고 자동 마감 끄기: 체크하거나 0', () => {
    expect(validateRetentionForm(form({ job_stale_days: '', job_stale_off: '1' }))).toMatchObject({ ok: true, value: { job_stale_days: 0 } });
    expect(validateRetentionForm(form({ job_stale_days: '0' }))).toMatchObject({ ok: true, value: { job_stale_days: 0 } });
    expect(formFromRetention(R({ job_stale_days: 0 }))).toMatchObject({ job_stale_days: '', job_stale_off: true });
  });
  it('개인정보 기간에는 0(끄기)이 없다', () => {
    for (const k of ['application_keep_days', 'vdoc_keep_days', 'access_log_keep_days'] as const) {
      expect(inRange(k, 0)).toBe(false);
      expect(validateRetentionForm(form({ [k]: '0' }))).toMatchObject({ ok: false, errors: { [k]: 'out_of_range' } });
    }
    expect(RETENTION_SPEC.filter((s) => s.offAllowed).map((s) => s.key)).toEqual(['job_stale_days']);
  });
});

describe('저장 계획 (rev = 다시 동의)', () => {
  it('개인정보 기간을 늘릴 때만 rev +1', () => {
    const cur = R({ rev: 2 });
    expect(planRetentionSave(cur, R({ application_keep_days: 200 }))).toMatchObject({ reconsent: true, lengthened: ['application_keep_days'], value: { rev: 3 } });
    expect(planRetentionSave(cur, R({ vdoc_keep_days: 400 })).value.rev).toBe(3);
    expect(planRetentionSave(cur, R({ access_log_keep_days: 800 })).value.rev).toBe(3);
    // 줄이기·자동 종료·자동 마감은 판을 바꾸지 않는다
    expect(planRetentionSave(cur, R({ application_keep_days: 90 }))).toMatchObject({ reconsent: false, shortened: ['application_keep_days'], value: { rev: 2 } });
    expect(planRetentionSave(cur, R({ application_auto_close_days: 60 }))).toMatchObject({ reconsent: false, value: { rev: 2 } });
    expect(planRetentionSave(cur, R({ job_stale_days: 0 }))).toMatchObject({ reconsent: false, value: { rev: 2 } });
    expect(planRetentionSave(cur, R({ job_stale_days: 180 })).value.rev).toBe(2);
    // 하나는 줄이고 하나는 늘리면 +1
    const mix = planRetentionSave(cur, R({ application_keep_days: 90, vdoc_keep_days: 730 }));
    expect(mix).toMatchObject({ reconsent: true, shortened: ['application_keep_days'], lengthened: ['vdoc_keep_days'], value: { rev: 3 } });
    expect(mix.changes).toEqual([{ key: 'application_keep_days', from: 180, to: 90 }, { key: 'vdoc_keep_days', from: 365, to: 730 }]);
    expect(planRetentionSave(cur, R()).changes).toEqual([]);
  });
  it('개인정보처리방침 판: rev 0 = 그대로, 그 뒤 +r<n>. 약관 판은 그대로', () => {
    expect(privacyVersion({ rev: 0 })).toBe(PRIVACY_VERSION);
    expect(privacyVersion({ rev: 1 })).toBe(`${PRIVACY_VERSION}+r1`);
    expect(requiredConsents(R({ rev: 4 }))).toEqual([{ type: 'terms', version: TERMS_VERSION }, { type: 'privacy', version: `${PRIVACY_VERSION}+r4` }]);
    const agreed = [{ type: 'terms', version: TERMS_VERSION, withdrawn_at: null }, { type: 'privacy', version: PRIVACY_VERSION, withdrawn_at: null }];
    expect(missingConsents(agreed, requiredConsents(R()))).toEqual([]);
    expect(missingConsents(agreed, requiredConsents(R({ rev: 1 })))).toEqual(['privacy']);
    expect(missingConsents([...agreed, { type: 'privacy', version: `${PRIVACY_VERSION}+r1`, withdrawn_at: null }], requiredConsents(R({ rev: 1 })))).toEqual([]);
  });
  it('국외 이전 동의 판에 보관 일수를 붙인다', () => {
    expect(crossBorderVersion(180)).toBe(`${CROSS_BORDER_VERSION}/k180`);
    expect(crossBorderVersion(90)).toBe(`${CROSS_BORDER_VERSION}/k90`);
  });
});

describe('변경 기록', () => {
  it('최근 20줄, 깨진 값은 새로 시작', () => {
    let raw: string | null = 'garbage';
    for (let i = 0; i < 25; i++) raw = appendRetentionLog(raw, { at: i, by: 'adm', changes: [{ key: 'job_stale_days', from: i, to: i + 1 }] });
    const log = parseRetentionLog(raw);
    expect(log).toHaveLength(RETENTION_LOG_MAX);
    expect(log[0]!.at).toBe(5);
    expect(log.at(-1)!.at).toBe(24);
    expect(parseRetentionLog('{"a":1}')).toEqual([]);
  });
});

describe('retentionSeconds', () => {
  it('일 → 초, 자동 마감 0 = null', () => {
    expect(retentionSeconds(DEFAULT_RETENTION)).toEqual({
      applicationKeepDays: 180, applicationAutoCloseDays: 30, vdocKeep: VDOC_KEEP_AFTER_REVIEW, accessLogKeep: ACCESS_LOG_KEEP, jobStale: JOB_STALE_AFTER,
    });
    expect(retentionSeconds(R({ job_stale_days: 0 })).jobStale).toBeNull();
  });
});

// ───────── 개인정보처리방침·동의 문구 채우기

const PLACEHOLDER = /\{(application_keep_days|application_auto_close_days|vdoc_keep|access_log_keep|stale_days)\}/;

describe('renderLegal', () => {
  const sec3 = (doc: ReturnType<typeof renderLegal>, l: 'ko' | 'zh') => doc[l].sections.find((s) => s.h.startsWith('3.'))!.items.join('\n');

  it('기본값으로 채우면 T-11 의 글과 숫자가 같다 (한국어·중국어)', () => {
    const d = renderLegal(PRIVACY, DEFAULT_RETENTION);
    const k = sec3(d, 'ko'), z = sec3(d, 'zh');
    expect(k).toContain('게재가 중단된 뒤 180일까지 보관한 뒤 삭제합니다');
    expect(k).toContain('마감 후 30일이 지나도록');
    expect(k).toContain('기업의 사업자 서류: 확인 후 1년');
    expect(k).toContain('지원서·서류의 열람 기록: 2년(');
    expect(k).toContain('2년간 보관한 뒤 삭제합니다'); // 바꿀 수 없는 기간은 글자 그대로
    expect(z).toContain('停止发布后180天再删除');
    expect(z).toContain('截止后30天仍未有结果');
    expect(z).toContain('企业的营业资料：确认后1年');
    expect(z).toContain('查看记录：2年（');
  });
  it('사용자 설정: 숫자가 바뀐다, 365 로 나누어떨어지면 연 단위', () => {
    const d = renderLegal(PRIVACY, R({ application_keep_days: 90, application_auto_close_days: 14, vdoc_keep_days: 1095, access_log_keep_days: 400 }));
    const k = sec3(d, 'ko'), z = sec3(d, 'zh');
    expect(k).toContain('중단된 뒤 90일까지');
    expect(k).toContain('마감 후 14일이 지나도록');
    expect(k).toContain('확인 후 3년');
    expect(k).toContain('열람 기록: 400일(');
    expect(z).toContain('停止发布后90天再删除');
    expect(z).toContain('截止后14天仍未');
    expect(z).toContain('确认后3年');
    expect(z).toContain('查看记录：400天（');
    expect(legalParams('ko', R({ access_log_keep_days: 1825 })).access_log_keep).toBe('5년');
    expect(legalParams('zh', R({ vdoc_keep_days: 730 })).vdoc_keep).toBe('2年');
    expect(legalParams('ko', R({ vdoc_keep_days: 90 })).vdoc_keep).toBe('90일');
  });
  it('어느 설정으로 채워도 자리표시자가 남지 않는다 (방침·약관 전체, 기간 문구 전부, 두 언어)', () => {
    const settings = [DEFAULT_RETENTION, R({ application_keep_days: 30, application_auto_close_days: 7, vdoc_keep_days: 90, access_log_keep_days: 1825, job_stale_days: 0 })];
    for (const r of settings) {
      for (const docs of [PRIVACY, TERMS]) expect(JSON.stringify(renderLegal(docs, r))).not.toMatch(/\{[a-z_]+\}/);
      for (const l of ['ko', 'zh'] as const) for (const key of RETENTION_TEXT_KEYS) expect(tRetention(l, key, r), `${l} ${key}`).not.toMatch(PLACEHOLDER);
    }
    // 원문에는 실제로 자리표시자가 있다 (채우는 쪽이 일을 한다)
    expect(JSON.stringify(PRIVACY)).toMatch(PLACEHOLDER);
    // 자리표시자를 쓰는 화면 문구는 RETENTION_TEXT_KEYS 에 모두 있다 (빠뜨린 키가 날것으로 보이지 않게)
    for (const dict of [ko, zh]) {
      const used = Object.entries(dict).filter(([, v]) => PLACEHOLDER.test(v)).map(([k]) => k).sort();
      expect(used).toEqual([...RETENTION_TEXT_KEYS].sort());
    }
    expect(fillLegal('{n}개 {application_keep_days}', legalParams('ko', DEFAULT_RETENTION))).toBe('{n}개 180일'); // 다른 자리표시자는 그대로
    expect(LEGAL_PARAMS).toHaveLength(5);
  });
  it('동의 문구(한·중)도 설정 숫자를 쓴다', () => {
    const r = R({ application_keep_days: 90, access_log_keep_days: 1095 });
    expect(tRetention('ko', 'consent.privacy.keep', r)).toContain('공고 마감 후 90일까지, 열람 기록은 3년');
    expect(tRetention('zh', 'consent.privacy.keep', r)).toContain('职位截止后90天，查看记录3年');
    for (const k of ['apply.consent.optional.text', 'apply.consent.required.text']) {
      expect(tRetention('ko', k, r)).toContain('공고 마감 후 90일까지');
      expect(tRetention('zh', k, r)).toContain('职位截止后90天或');
    }
    expect(tRetention('ko', 'consent.privacy.keep', DEFAULT_RETENTION)).toContain('공고 마감 후 180일까지, 열람 기록은 2년');
  });
});
