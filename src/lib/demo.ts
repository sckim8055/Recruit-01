// 시연 계정 (테스트 서버·로컬 개발 전용). 순수 함수와 상수만 둔다 (DB·네트워크 접근 없음) — test/demo.test.ts 로 검증한다.
//
// 왜 있는가: 로그인은 이메일 인증코드뿐이라, 메일을 받을 수 없는 공개 시연 계정으로는 들어올 수 없다.
//   테스트 서버(가짜 데이터만 — CLAUDE.md 규칙 10)를 여러 사람이 역할별로 둘러볼 수 있게, 정해 둔 시연 계정으로
//   인증코드 없이 들어오는 길을 하나 둔다 (POST /login/demo, routes/auth.tsx).
//
// 안전장치 (완화하지 않는다 — 바꾸려면 운영자 확인):
//   1) demoEnabled() 가 참일 때만 동작한다: APP_ENV 가 production 이 아니고 DEMO_LOGIN 이 "on".
//      운영 서버에서는 DEMO_LOGIN 을 켜도 꺼진 것으로 본다. 배포 전 점검(scripts/lib/deploy-checks.mjs)과
//      /admin/system(lib/config-check.ts)도 운영 구역의 DEMO_LOGIN = "on" 을 문제로 본다.
//   2) 들어올 수 있는 계정은 아래 DEMO_ACCOUNTS 의 고정 id 뿐이다. 주소·폼에서 받은 값으로 회원을 찾지 않는다.
//   3) 관리자(admin)는 시연 계정이 될 수 없다 (타입과 실행 시 검사 둘 다). 시연 세션은 mfa = 0 이라 관리자 권한을 가질 수도 없다.
//   4) 시연 데이터는 id 가 모두 `de30000` 으로 시작한다. 넣기·되돌리기(lib/demo-seed.ts)는 그 id 의 행과 시연 회원 소유의 행만 건드린다.
import type { Locale } from '../env';

export type DemoRole = 'seeker' | 'company';

/** 시연 데이터의 고정 id. 종류(kind) 1 회원 · 2 기업 · 3 공고 · 4 이력서 · 5 지원 · 6 검증 서류 · 7 동의 · 8 이벤트·열람 기록. */
export const demoId = (kind: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, n: number): string =>
  `de30000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const DEMO_ID_RE = /^de30000[1-8]-0000-4000-8000-\d{12}$/;
export const isDemoId = (id: string): boolean => DEMO_ID_RE.test(id);
export const isDemoUserId = (id: string): boolean => isDemoId(id) && id.startsWith('de300001-');

/** 시연 계정의 메일 도메인. `.example` 은 예약된 최상위 도메인이라 실제 메일함이 없다 (RFC 2606). */
export const DEMO_MAIL_DOMAIN = 'demo.example';
/** 시연 주소인가 (받는 사람이 없는 주소 — lib/email.ts 가 실제로 보내지 않는다). */
export const isDemoAddress = (email: string): boolean => {
  const e = email.trim().toLowerCase();
  return e.endsWith(`@${DEMO_MAIL_DOMAIN}`) || e.endsWith(`.${DEMO_MAIL_DOMAIN}`);
};

/** 시연 로그인이 켜져 있는가. 운영(production)에서는 설정과 상관없이 항상 꺼져 있다. */
export function demoEnabled(env: { APP_ENV?: unknown; DEMO_LOGIN?: unknown }): boolean {
  return (env.APP_ENV === 'test' || env.APP_ENV === 'dev') && env.DEMO_LOGIN === 'on';
}

export interface DemoAccount {
  /** 폼의 account 값이자 문구 키의 일부 (demo.acct.<key>, demo.acct.<key>.d). */
  key: string;
  userId: string;
  role: DemoRole;
  email: string;
  locale: Locale;
}

/** 로그인 화면에 보이는 시연 계정 (화면 순서). 이 목록 밖의 회원은 시연 로그인으로 들어올 수 없다. */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { key: 'seeker', userId: demoId(1, 1), role: 'seeker', email: `seeker.kim@${DEMO_MAIL_DOMAIN}`, locale: 'ko' },
  { key: 'seeker_new', userId: demoId(1, 2), role: 'seeker', email: `seeker.lee@${DEMO_MAIL_DOMAIN}`, locale: 'ko' },
  { key: 'company', userId: demoId(1, 11), role: 'company', email: `hr@lanhai.${DEMO_MAIL_DOMAIN}`, locale: 'ko' },
  { key: 'company_hq', userId: demoId(1, 12), role: 'company', email: `hq@lanhai.${DEMO_MAIL_DOMAIN}`, locale: 'zh' },
  { key: 'company_new', userId: demoId(1, 15), role: 'company', email: `owner@hechang.${DEMO_MAIL_DOMAIN}`, locale: 'ko' },
];

export const findDemoAccount = (key: string): DemoAccount | null => DEMO_ACCOUNTS.find((a) => a.key === key) ?? null;

// ── 넣기·되돌리기 시점

/** site_settings 의 키. 값: {"v": <DEMO_SEED_VERSION>, "at": <unix 초>}. */
export const DEMO_STAMP_KEY = 'demo.seed';
/** 시연 데이터(lib/demo-data.ts)나 넣는 방법을 바꾸면 올린다 — 다음 시연 로그인 때 다시 넣는다. */
export const DEMO_SEED_VERSION = 1;
/** 이 시간이 지나면 다음 시연 로그인 때 원래대로 되돌린다. */
export const DEMO_RESET_AFTER = 24 * 3600;

export interface DemoStamp { v: number; at: number }

export function parseDemoStamp(raw: string | null): DemoStamp | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return typeof o.v === 'number' && typeof o.at === 'number' ? { v: o.v, at: o.at } : null;
  } catch {
    return null;
  }
}

/** 지금 시연 데이터를 다시 넣어야 하는가: 넣은 적이 없거나, 판이 다르거나, 넣은 지 하루가 지났다. */
export function demoSeedDue(stamp: DemoStamp | null, now: number): boolean {
  return !stamp || stamp.v !== DEMO_SEED_VERSION || now - stamp.at >= DEMO_RESET_AFTER || stamp.at > now;
}
