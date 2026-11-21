// 설정 점검 (T-13, src/lib/config-check.ts). 순수 함수 — 모든 값은 가짜다.
import { describe, expect, it } from 'vitest';
import {
  CHECK_IDS, configChecks, configProblems, DEV_SESSION_PEPPER, encKeyBytes, legalMarkerCounts, lengthClass, secretSummary, worstLevel,
  type CheckId, type CheckItem,
} from '../src/lib/config-check';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';

const KEY32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const PEPPER = 'fake-server-pepper-0123456789abcdef';
const RESEND = 're_fake_resend_key_000000000000';
const ANTH = 'sk-ant-fake-000000000000000000000';
const NO_LEGAL = { ko: 0, zh: 0 };

/** 모든 항목이 정상인 가짜 운영 env. */
const good = (o: Record<string, unknown> = {}) => ({
  APP_ENV: 'production', ENC_KEY: KEY32, SESSION_PEPPER: PEPPER, RESEND_API_KEY: RESEND, ANTHROPIC_API_KEY: ANTH,
  APP_ORIGIN: 'https://example-recruit.test', MAIL_FROM: 'Recruit <no-reply@example-recruit.test>', REGISTRATION_NO: '제2026-1호',
  OPERATOR_DOMAINS: 'example-recruit.test', FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off',
  FLAG_PAID_LABEL: 'off', MAINTENANCE: 'off', DB: {}, FILES: {}, ...o,
});

const pick = (items: CheckItem[], id: CheckId) => items.find((i) => i.id === id)!;
const one = (o: Record<string, unknown>, id: CheckId, legal = NO_LEGAL) => pick(configChecks(good(o), legal), id);

describe('설정 점검 (T-13)', () => {
  it('정상인 운영 설정: 모든 항목 ok, 순서 = CHECK_IDS', () => {
    const items = configChecks(good(), NO_LEGAL);
    expect(items.map((i) => i.id)).toEqual([...CHECK_IDS]);
    expect(items.filter((i) => i.level !== 'ok')).toEqual([]);
    expect(configProblems(good(), NO_LEGAL)).toEqual([]);
    expect(worstLevel(items)).toBe('ok');
  });

  it('APP_ENV 가 알 수 없는 값이면 문제', () => expect(one({ APP_ENV: 'prod' }, 'app_env')).toMatchObject({ level: 'problem', code: 'unknown' }));

  it('ENC_KEY: 없음 · 32바이트 아님 · base64 아님 → 문제', () => {
    expect(one({ ENC_KEY: undefined }, 'enc_key')).toMatchObject({ level: 'problem', code: 'missing' });
    expect(one({ ENC_KEY: btoa('short') }, 'enc_key')).toMatchObject({ level: 'problem', code: 'bad_length' });
    expect(one({ ENC_KEY: '!!!not base64!!!' }, 'enc_key')).toMatchObject({ level: 'problem', code: 'bad_length' });
    expect(encKeyBytes(KEY32)).toBe(32);
    expect(encKeyBytes(KEY32.replace(/\+/g, '-').replace(/\//g, '_'))).toBe(32); // base64url 도 crypto.fromB64 처럼 받는다
  });

  it('SESSION_PEPPER: 없음 · 16자 미만 · 로컬 예시 값(서버에서) → 문제, 로컬 개발에서는 예시 값 ok', () => {
    expect(one({ SESSION_PEPPER: '' }, 'session_pepper')).toMatchObject({ level: 'problem', code: 'missing' });
    expect(one({ SESSION_PEPPER: 'x'.repeat(15) }, 'session_pepper')).toMatchObject({ level: 'problem', code: 'short', n: 16 });
    expect(one({ SESSION_PEPPER: DEV_SESSION_PEPPER }, 'session_pepper')).toMatchObject({ level: 'problem', code: 'dev_value' });
    expect(one({ SESSION_PEPPER: DEV_SESSION_PEPPER, APP_ENV: 'test' }, 'session_pepper')).toMatchObject({ level: 'problem', code: 'dev_value' });
    expect(one({ SESSION_PEPPER: DEV_SESSION_PEPPER, APP_ENV: 'dev' }, 'session_pepper')).toMatchObject({ level: 'ok' });
  });

  it('APP_ORIGIN: 없음 · 자리표시자 · https 아님 → 문제 (로컬 개발의 http 는 확인)', () => {
    expect(one({ APP_ORIGIN: '' }, 'app_origin').code).toBe('missing');
    expect(one({ APP_ORIGIN: 'https://REPLACE_WITH_PRODUCTION_DOMAIN' }, 'app_origin')).toMatchObject({ level: 'problem', code: 'placeholder' });
    expect(one({ APP_ORIGIN: 'http://example-recruit.test' }, 'app_origin')).toMatchObject({ level: 'problem', code: 'not_https' });
    expect(one({ APP_ORIGIN: 'https://example-recruit.test/' }, 'app_origin').code).toBe('not_https');
    expect(one({ APP_ORIGIN: 'http://localhost:8787', APP_ENV: 'dev' }, 'app_origin').level).toBe('warning');
  });

  it('MAIL_FROM: 없음 · 자리표시자 → 문제 (로컬 개발은 확인)', () => {
    expect(one({ MAIL_FROM: '' }, 'mail_from')).toMatchObject({ level: 'problem', code: 'missing' });
    expect(one({ MAIL_FROM: 'Recruit <no-reply@REPLACE_WITH_PRODUCTION_DOMAIN>' }, 'mail_from').code).toBe('placeholder');
    expect(one({ MAIL_FROM: '', APP_ENV: 'dev' }, 'mail_from').level).toBe('warning');
  });

  it('RESEND_API_KEY 없음: 운영 = 문제, 테스트 = 확인(로그인 불가 안내), 로컬 = ok(콘솔 출력)', () => {
    expect(one({ RESEND_API_KEY: undefined }, 'resend')).toMatchObject({ level: 'problem', code: 'missing' });
    expect(one({ RESEND_API_KEY: '', APP_ENV: 'test' }, 'resend')).toMatchObject({ level: 'warning', code: 'missing_test' });
    expect(one({ RESEND_API_KEY: '', APP_ENV: 'dev' }, 'resend')).toMatchObject({ level: 'ok', code: 'dev_console' });
  });

  it('신고번호 없음: 운영에서만 확인(게재는 publishBlocks 가 막는다)', () => {
    expect(one({ REGISTRATION_NO: ' ' }, 'registration_no')).toMatchObject({ level: 'warning', code: 'missing' });
    expect(one({ REGISTRATION_NO: '', APP_ENV: 'test' }, 'registration_no')).toMatchObject({ level: 'ok', code: 'not_needed' });
  });

  it('【확인 필요】 표시: 운영 = 문제(개수), 그 밖 = 확인. 지금 문서에는 표시가 남아 있다', () => {
    expect(one({}, 'legal_markers', { ko: 3, zh: 2 })).toMatchObject({ level: 'problem', code: 'left', n: 5 });
    expect(one({ APP_ENV: 'test' }, 'legal_markers', { ko: 1, zh: 0 })).toMatchObject({ level: 'warning', n: 1 });
    const now = legalMarkerCounts();
    expect(now.ko).toBeGreaterThan(0); // 운영자가 채우면 test/account.test.ts 와 함께 이 줄도 toBe(0) 으로 바꾼다
    expect(now.zh).toBeGreaterThan(0);
    expect(pick(configChecks(good()), 'legal_markers').level).toBe('problem'); // 기본 인자 = 지금 문서
  });

  it('운영자 도메인: 운영에서 비면 문제, 자리표시자는 문제', () => {
    expect(one({ OPERATOR_DOMAINS: ' , ' }, 'operator_domains')).toMatchObject({ level: 'problem', code: 'missing' });
    expect(one({ OPERATOR_DOMAINS: '', APP_ENV: 'test' }, 'operator_domains').level).toBe('warning');
    expect(one({ OPERATOR_DOMAINS: 'REPLACE_WITH_PRODUCTION_DOMAIN,a.test' }, 'operator_domains').code).toBe('placeholder');
  });

  it('기능 플래그가 켜져 있으면 확인(개수)만', () => {
    expect(one({ FLAG_PAID_LABEL: 'on', FLAG_PRODUCTION_JOBS: 'on' }, 'flags')).toMatchObject({ level: 'warning', code: 'on', n: 2 });
    expect(one({ FLAG_PAID_LABEL: 'ON' }, 'flags').level).toBe('ok'); // flagsOf 와 같게 "on" 만 켜짐
  });

  it('D1·R2 바인딩이 없으면 문제(개수)', () => {
    expect(one({ DB: undefined }, 'bindings')).toMatchObject({ level: 'problem', n: 1 });
    expect(one({ DB: undefined, FILES: undefined }, 'bindings').n).toBe(2);
  });

  it('점검 모드·현지화 엔진', () => {
    expect(one({ MAINTENANCE: 'on' }, 'maintenance').level).toBe('warning');
    expect(one({ ANTHROPIC_API_KEY: '' }, 'localize')).toMatchObject({ level: 'warning', code: 'none' });
    expect(one({ ANTHROPIC_API_KEY: '', AI: { run: () => null } }, 'localize')).toMatchObject({ level: 'ok', n: 1 });
  });

  it('결과에도 비밀값 표에도 비밀값이 없다 (설정됨/없음·길이 구간만)', () => {
    const env = good({ ENC_KEY: KEY32, SESSION_PEPPER: PEPPER, GEMINI_API_KEY: 'AIza-fake-gemini-key-0000000000' });
    const out = JSON.stringify([configChecks(env), secretSummary(env), configChecks(good({ ENC_KEY: btoa('short-key-value') }))]);
    for (const secret of [KEY32, PEPPER, RESEND, ANTH, 'AIza-fake-gemini-key-0000000000', btoa('short-key-value')]) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.slice(0, 6));
      expect(out).not.toContain(secret.slice(-6));
    }
    expect(secretSummary(env)).toEqual([
      { name: 'ENC_KEY', set: true, length: 'long' },
      { name: 'SESSION_PEPPER', set: true, length: 'long' },
      { name: 'RESEND_API_KEY', set: true, length: 'medium' },
      { name: 'ANTHROPIC_API_KEY', set: true, length: 'long' },
      { name: 'GEMINI_API_KEY', set: true, length: 'medium' },
    ]);
    expect(secretSummary({}).every((s) => !s.set && s.length === 'none')).toBe(true);
    expect([lengthClass('a'.repeat(15)), lengthClass('a'.repeat(16)), lengthClass('a'.repeat(32))]).toEqual(['short', 'medium', 'long']);
  });

  it('모든 결과 코드에 한국어·중국어 문구가 있다', () => {
    const variants: Record<string, unknown>[] = [
      {}, { APP_ENV: 'x' }, { ENC_KEY: '' }, { ENC_KEY: btoa('a') }, { SESSION_PEPPER: '' }, { SESSION_PEPPER: 'short' }, { SESSION_PEPPER: DEV_SESSION_PEPPER },
      { APP_ORIGIN: '' }, { APP_ORIGIN: 'https://REPLACE_WITH_X' }, { APP_ORIGIN: 'http://a' }, { MAIL_FROM: '' }, { MAIL_FROM: 'REPLACE_WITH_X' },
      { RESEND_API_KEY: '' }, { RESEND_API_KEY: '', APP_ENV: 'test' }, { RESEND_API_KEY: '', APP_ENV: 'dev' }, { REGISTRATION_NO: '' },
      { REGISTRATION_NO: '', APP_ENV: 'test' }, { OPERATOR_DOMAINS: '' }, { OPERATOR_DOMAINS: 'REPLACE_WITH_X' }, { FLAG_PAID_LABEL: 'on' },
      { DB: undefined }, { MAINTENANCE: 'on' }, { ANTHROPIC_API_KEY: '' },
    ];
    const keys = new Set<string>();
    for (const v of variants) for (const legal of [NO_LEGAL, { ko: 1, zh: 1 }]) for (const c of configChecks(good(v), legal)) keys.add(`sys.res.${c.id}.${c.code}`);
    for (const id of CHECK_IDS) keys.add(`sys.chk.${id}`);
    const missing = [...keys].filter((k) => !(k in ko) || !(k in zh));
    expect(missing).toEqual([]);
  });
});
