// 실행 환경 값과 요청 컨텍스트 타입 (T-19: Cloudflare 바인딩 대신 Node 서버가 만든 DB·파일 저장소 + .env 의 문자열).
// 서버(src/server.ts)는 .env 를 읽어 이 Env 를 한 번 만들고 모든 요청에 같은 것을 넘긴다. 테스트는 가짜 Env 를 넘긴다.
import type { Db } from './db/types';
import type { FileStore } from './lib/storage';
import type { PageCache } from './lib/page-cache';

export type Role = 'seeker' | 'company' | 'headhunter' | 'admin';
export type Locale = 'ko' | 'zh';

/** 서버가 넣는 실행 정보 (/admin/system 의 점검). 테스트에서는 없어도 된다. */
export interface RuntimeInfo {
  /** 파일 저장소 폴더 (DATA_DIR/files) · 백업 폴더 (BACKUP_DIR). 절대 경로. */
  filesDir: string;
  backupDir: string;
  /** 서버가 시작된 시각 (unix 초). */
  startedAt: number;
  /** 예약 작업 실행기가 켜져 있는가 (같은 PC 에서 서버를 두 개 띄우면 한쪽만 실행한다 — DB 잠금). */
  schedulerOn: boolean;
}

export interface Env {
  /** PostgreSQL (src/db/pg.ts 의 D1 모양 어댑터). */
  DB: Db;
  /** 첨부파일 저장소 (src/lib/storage.ts, DATA_DIR/files). */
  FILES: FileStore;
  RUNTIME?: RuntimeInfo;
  /** 공개 화면 캐시 (src/lib/page-cache.ts, 서버 메모리 60초). 없으면 캐시하지 않는다 (테스트). */
  PAGE_CACHE?: PageCache;
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
  // 시연 계정 로그인(lib/demo.ts): "on" 이고 APP_ENV 가 test·dev 일 때만 켜진다. 운영은 항상 "off".
  DEMO_LOGIN?: string;
  // 공고 현지화 엔진 (src/lib/localize/). 비어 있으면 기본 순서(claude → gemini) 중 쓸 수 있는 것을 쓴다.
  LOCALIZE_ENGINE?: string;
  LOCALIZE_GEMINI_MODEL?: string;
  LOCALIZE_CLAUDE_MODEL?: string;
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
  // 조건 알림(T-10): 사이트 전체 하루 알림 메일(기본 40) · 예약 작업 한 번에 처리하는 알림 수(기본 8, 최대 50 — lib/limits.alertRunCap). 관리자 설정이 먼저.
  ALERT_MAIL_SITE_DAY?: string;
  ALERT_SEND_PER_RUN?: string;
  // 파일·백업 폴더 (T-19). 비우면 F:\works\Recruit-01-data\files · …\backups (src/server.ts).
  DATA_DIR?: string;
  BACKUP_DIR?: string;
  // secrets (.env 에만. git·대화창에 넣지 않는다)
  ENC_KEY: string;
  SESSION_PEPPER: string;
  RESEND_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** PostgreSQL 접속 문자열 (비밀번호 포함). 화면·로그에는 "설정됨/없음" 만. */
  DATABASE_URL?: string;
  /** 자동 백업 비밀문구 (선택, docs/DEPLOY.md 7장). */
  BACKUP_PASSPHRASE?: string;
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
