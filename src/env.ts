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
  // secrets
  ENC_KEY: string;
  SESSION_PEPPER: string;
  RESEND_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
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
