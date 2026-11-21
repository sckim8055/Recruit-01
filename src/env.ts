// 실행 환경 바인딩과 요청 컨텍스트 타입.
export type Role = 'seeker' | 'company' | 'headhunter' | 'admin';
export type Locale = 'ko' | 'zh';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: 'dev' | 'test' | 'production';
  APP_ORIGIN: string;
  MAIL_FROM: string;
  OPERATOR_DOMAINS: string;
  REGISTRATION_NO: string;
  FLAG_PRODUCTION_JOBS: string;
  FLAG_HEADHUNTER_POSTING: string;
  FLAG_RESUME_ZH_SUMMARY: string;
  FLAG_PAID_LABEL: string;
  // 점검 모드(T-13): "on" 이면 관리자·로그인·/api/health 말고 모든 요청에 503 점검 안내 (src/lib/pause.ts). 그 밖의 값·없음 = 꺼짐.
  MAINTENANCE?: string;
  // 공고 현지화 엔진 (src/lib/localize/). 비어 있으면 기본 순서(claude → gemini → workers_ai) 중 쓸 수 있는 것을 쓴다.
  LOCALIZE_ENGINE?: string;
  LOCALIZE_WORKERS_AI_MODEL?: string;
  LOCALIZE_GEMINI_MODEL?: string;
  LOCALIZE_CLAUDE_MODEL?: string;
  // Workers AI 바인딩. wrangler.jsonc 의 "ai" 설정을 켜야 생긴다 (운영자가 Cloudflare 에 로그인한 뒤).
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  // 예약 작업(T-12)의 하루 보고를 받을 운영자 주소. 비어 있으면 보고 메일을 보내지 않는다 (lib/maintenance.report).
  OPS_EMAIL?: string;
  // 남용 방지 한도(T-05c, src/lib/limits.ts). 0 이상의 정수 문자열. 비었거나 잘못된 값이면 코드의 기본값을 쓴다.
  // T-17: 관리자 설정(site_settings 'limits', /admin/settings)이 있는 칸은 그 값이 먼저다 (관리자 설정 → 이 변수 → 기본값).
  LOCALIZE_PER_COMPANY_DAY?: string;
  LOCALIZE_SITE_DAY?: string;
  ADMIN_LOCALIZE_TEST_DAY?: string;
  MAIL_PER_COMPANY_DAY?: string;
  MAIL_SITE_DAY?: string;
  DRAFT_JOBS_PER_COMPANY?: string;
  // 조건 알림(T-10): 사이트 전체 하루 알림 메일(기본 40) · 예약 작업 한 번에 처리하는 알림 수(기본 8, 최대 10 — lib/limits.alertRunCap). 관리자 설정이 먼저.
  ALERT_MAIL_SITE_DAY?: string;
  ALERT_SEND_PER_RUN?: string;
  // secrets
  ENC_KEY: string;
  SESSION_PEPPER: string;
  RESEND_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  locale: Locale;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser | null; locale: Locale };
};

export interface Flags {
  productionJobs: boolean;
  headhunterPosting: boolean;
  resumeZhSummary: boolean;
  paidLabel: boolean;
}

export function flagsOf(env: Env): Flags {
  return {
    productionJobs: env.FLAG_PRODUCTION_JOBS === 'on',
    headhunterPosting: env.FLAG_HEADHUNTER_POSTING === 'on',
    resumeZhSummary: env.FLAG_RESUME_ZH_SUMMARY === 'on',
    paidLabel: env.FLAG_PAID_LABEL === 'on',
  };
}

export const now = (): number => Math.floor(Date.now() / 1000);
