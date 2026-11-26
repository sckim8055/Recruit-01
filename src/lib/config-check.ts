// 설정 점검 (T-13). 순수 함수: env(바인딩·변수·비밀값)를 받아 점검 항목 목록을 돌려준다. 화면은 GET /admin/system 하나뿐이다.
//
// 원칙
// - 비밀값의 **값은 절대 돌려주지 않는다.** 돌려주는 것은 "설정됨/없음" 과 길이 구간뿐이다 (secretSummary). 점검 항목의 문구도 문구 키 + 숫자만.
// - 점검 결과로 요청을 막지 않는다 (사이트는 항상 뜬다). 운영자가 /admin/system 에서 보고 고친다.
// - /api/health 에는 아무것도 보이지 않는다 (공개 주소).
// - 게재 판단은 여전히 rules.publishBlocks 만 한다 (신고번호 없음 = 게재 불가). 여기서는 운영자에게 알리기만 한다.
import type { Env } from '../env';
import { fromB64 } from './crypto';
import { PRIVACY } from '../legal/privacy';
import { TERMS } from '../legal/terms';

export type CheckLevel = 'ok' | 'warning' | 'problem';
export interface CheckItem {
  /** 점검 이름. 화면 문구는 sys.chk.<id> (이름), sys.fix.<id>.<code> (고치는 법). */
  id: CheckId;
  level: CheckLevel;
  /** 결과 종류 (문구 키의 끝). 'ok' 면 고칠 것이 없다. */
  code: string;
  /** 문구에 넣을 숫자 (개수 등). 비밀값·주소 같은 글은 넣지 않는다. */
  n?: number;
}

export const CHECK_IDS = [
  'app_env', 'enc_key', 'session_pepper', 'app_origin', 'mail_from', 'resend', 'registration_no', 'legal_markers',
  'operator_domains', 'flags', 'bindings', 'maintenance', 'localize', 'demo',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** .dev.vars.example 에 적어 둔 로컬 전용 값. 테스트·운영 서버에서 쓰면 문제로 본다. */
export const DEV_SESSION_PEPPER = 'dev-pepper-local-only-1234';
export const PEPPER_MIN = 16;
export const PLACEHOLDER = 'REPLACE_WITH_';
const FLAG_KEYS = ['FLAG_PRODUCTION_JOBS', 'FLAG_HEADHUNTER_POSTING', 'FLAG_RESUME_ZH_SUMMARY', 'FLAG_PAID_LABEL'] as const;

/** 약관·개인정보처리방침에 남은 표시 개수 (한국어 【확인 필요 · 중국어 【待确认). test/account.test.ts 와 같은 방식으로 센다. */
export function legalMarkerCounts(): { ko: number; zh: number } {
  const count = (s: string, m: string) => s.split(m).length - 1;
  return {
    ko: count(JSON.stringify([TERMS.ko, PRIVACY.ko]), '【확인 필요'),
    zh: count(JSON.stringify([TERMS.zh, PRIVACY.zh]), '【待确认'),
  };
}

/** ENC_KEY 가 base64 로 32바이트인가. 값은 밖으로 내보내지 않는다. */
export function encKeyBytes(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    return fromB64(v.trim()).length;
  } catch {
    return -1; // base64 가 아님
  }
}

export type SecretName = 'ENC_KEY' | 'SESSION_PEPPER' | 'RESEND_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY';
export const SECRET_NAMES: readonly SecretName[] = ['ENC_KEY', 'SESSION_PEPPER', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
/** 길이 구간: 값의 길이를 그대로 보이지 않는다 (비밀값 추측에 도움이 되지 않게 구간으로만). */
export type LengthClass = 'none' | 'short' | 'medium' | 'long';
export interface SecretState { name: SecretName; set: boolean; length: LengthClass }

export const lengthClass = (v: unknown): LengthClass => {
  if (typeof v !== 'string' || !v) return 'none';
  return v.length < 16 ? 'short' : v.length < 32 ? 'medium' : 'long';
};

/** 비밀값 표: 이름 · 설정됨/없음 · 길이 구간. 값·앞자리·끝자리는 넣지 않는다. */
export const secretSummary = (env: Partial<Record<SecretName, unknown>>): SecretState[] =>
  SECRET_NAMES.map((name) => ({ name, set: typeof env[name] === 'string' && (env[name] as string).length > 0, length: lengthClass(env[name]) }));

/** 점검에 쓰는 env: 실제 Env 도, 테스트의 가짜 객체도 받는다 (값의 모양은 함수 안에서 확인한다). */
export type CheckEnv = { [K in keyof Env]?: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 점검 목록 (화면 순서 = CHECK_IDS). legal 은 테스트에서 바꿔 넣을 수 있게 인자로 받는다 (기본: 지금 문서의 개수).
 * 수준: problem = 서버가 제대로 동작하지 않거나 운영에서 하면 안 되는 상태, warning = 알아 둘 것, ok.
 */
export function configChecks(env: CheckEnv, legal: { ko: number; zh: number } = legalMarkerCounts()): CheckItem[] {
  const appEnv = str(env.APP_ENV);
  const prod = appEnv === 'production';
  const dev = appEnv === 'dev';
  const out: CheckItem[] = [];
  const add = (id: CheckId, level: CheckLevel, code: string, n?: number) => out.push(n === undefined ? { id, level, code } : { id, level, code, n });

  // 실행 환경
  if (!['dev', 'test', 'production'].includes(appEnv)) add('app_env', 'problem', 'unknown');
  else add('app_env', 'ok', 'ok');

  // ENC_KEY: 32바이트 base64
  const kb = encKeyBytes(env.ENC_KEY);
  if (kb === null) add('enc_key', 'problem', 'missing');
  else if (kb !== 32) add('enc_key', 'problem', 'bad_length');
  else add('enc_key', 'ok', 'ok');

  // SESSION_PEPPER: 16자 이상, 로컬 예시 값이 아님
  const pep = typeof env.SESSION_PEPPER === 'string' ? env.SESSION_PEPPER : '';
  if (!pep) add('session_pepper', 'problem', 'missing');
  else if (pep.length < PEPPER_MIN) add('session_pepper', 'problem', 'short', PEPPER_MIN);
  else if (pep === DEV_SESSION_PEPPER && !dev) add('session_pepper', 'problem', 'dev_value');
  else add('session_pepper', 'ok', 'ok');

  // APP_ORIGIN: https, 자리표시자 없음 (로컬 개발은 http 도 괜찮다)
  const origin = str(env.APP_ORIGIN);
  if (!origin) add('app_origin', 'problem', 'missing');
  else if (origin.includes(PLACEHOLDER)) add('app_origin', 'problem', 'placeholder');
  else if (!/^https:\/\/[^/\s]+$/.test(origin)) add('app_origin', dev ? 'warning' : 'problem', 'not_https');
  else add('app_origin', 'ok', 'ok');

  // MAIL_FROM
  const from = str(env.MAIL_FROM);
  if (!from) add('mail_from', dev ? 'warning' : 'problem', 'missing');
  else if (from.includes(PLACEHOLDER)) add('mail_from', 'problem', 'placeholder');
  else add('mail_from', 'ok', 'ok');

  // Resend 키: 운영 = 문제, 테스트 = 경고(아무도 로그인할 수 없음), 로컬 = 콘솔 출력
  if (str(env.RESEND_API_KEY)) add('resend', 'ok', 'ok');
  else if (prod) add('resend', 'problem', 'missing');
  else if (dev) add('resend', 'ok', 'dev_console');
  else add('resend', 'warning', 'missing_test');

  // 신고번호: 운영에서 비어 있으면 경고 (publishBlocks 가 이미 게재를 막는다)
  if (str(env.REGISTRATION_NO)) add('registration_no', 'ok', 'ok');
  else add('registration_no', prod ? 'warning' : 'ok', prod ? 'missing' : 'not_needed');

  // 약관·방침의 【확인 필요】 표시
  const marks = legal.ko + legal.zh;
  if (!marks) add('legal_markers', 'ok', 'ok');
  else add('legal_markers', prod ? 'problem' : 'warning', 'left', marks);

  // 운영자 도메인 (공고 연락처 금지 목록)
  const od = str(env.OPERATOR_DOMAINS);
  if (od.includes(PLACEHOLDER)) add('operator_domains', 'problem', 'placeholder');
  else if (!od.split(',').some((d) => d.trim())) add('operator_domains', prod ? 'problem' : 'warning', 'missing');
  else add('operator_domains', 'ok', 'ok');

  // 기능 플래그: 켜진 것이 있으면 경고만 (켜는 것은 운영자 결정 — ARCHITECTURE 5장)
  const on = FLAG_KEYS.filter((k) => str(env[k]) === 'on').length;
  if (on) add('flags', 'warning', 'on', on);
  else add('flags', 'ok', 'ok');

  // 바인딩 (D1·R2). 없으면 사이트가 동작하지 않는다.
  const missing = [env.DB, env.FILES].filter((b) => !b).length;
  if (missing) add('bindings', 'problem', 'missing', missing);
  else add('bindings', 'ok', 'ok');

  // 점검 모드
  if (str(env.MAINTENANCE) === 'on') add('maintenance', 'warning', 'on');
  else add('maintenance', 'ok', 'ok');

  // 현지화 엔진: 없으면 기업이 한국어를 직접 입력 (동작은 한다)
  const ai = env.AI as { run?: unknown } | undefined;
  const engines = (str(env.ANTHROPIC_API_KEY) ? 1 : 0) + (str(env.GEMINI_API_KEY) ? 1 : 0) + (ai && typeof ai.run === 'function' ? 1 : 0);
  if (engines) add('localize', 'ok', 'ok', engines);
  else add('localize', 'warning', 'none');

  // 시연 계정 로그인 (lib/demo.ts): 운영에서 켜져 있으면 문제 (동작은 코드가 막는다), 테스트·로컬에서 켜져 있으면 알림
  if (str(env.DEMO_LOGIN) !== 'on') add('demo', 'ok', 'ok');
  else add('demo', prod ? 'problem' : 'warning', prod ? 'on_production' : 'on');

  return out;
}

/** ok 가 아닌 것만. */
export const configProblems = (env: CheckEnv, legal?: { ko: number; zh: number }): CheckItem[] =>
  configChecks(env, legal).filter((c) => c.level !== 'ok');

/** 화면 맨 위 요약: 가장 나쁜 수준. */
export const worstLevel = (items: CheckItem[]): CheckLevel =>
  items.some((i) => i.level === 'problem') ? 'problem' : items.some((i) => i.level === 'warning') ? 'warning' : 'ok';
