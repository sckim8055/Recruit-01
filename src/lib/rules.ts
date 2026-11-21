// 법적 제약을 코드로 강제하는 곳. 순수 함수만 둔다 (DB·네트워크 접근 없음) — test/rules.test.ts 로 검증한다.
// 근거와 배경은 docs/ARCHITECTURE.md 5장. 이 파일의 규칙을 완화하려면 먼저 그 문서를 고치고 운영자 확인을 받는다.
import type { Flags } from '../env';

// ── 금지 표현: 직업정보제공사업자는 "취업상담·취업추천·취업지원" 등의 표현을 쓸 수 없다.
export const BANNED_PHRASES = ['취업상담', '취업추천', '취업지원', '취업알선', '취업 상담', '취업 추천', '취업 지원', '취업 알선'];

export function findBannedPhrases(text: string): string[] {
  return BANNED_PHRASES.filter((p) => text.includes(p));
}

// ── 기술유출 브로커 리스크: 국가핵심기술 분야 R&D 직무와 특정 국내 기업 출신을 겨냥한 공고는
//    자동 게재하지 않고 관리자 검토로 보낸다.
const TECH_FIELDS = /(반도체|배터리|이차전지|2차전지|디스플레이|OLED|半导体|电池|显示)/i;
const RND_WORDS = /(R&D|연구개발|연구원|공정\s*엔지니어|설계\s*엔지니어|공정개발|회로설계|研发|工艺|工程师)/i;
const TARGETED = /(삼성|SK\s*하이닉스|SK하이닉스|LG\s*에너지|LG에너지|LG\s*디스플레이|LG디스플레이|SK\s*온|SK온|현대)[^\n]{0,20}(출신|경력자|재직자|근무\s*경력)/i;

export function techLeakFlag(text: string): string | null {
  if (TARGETED.test(text)) return 'targeted_company';
  if (TECH_FIELDS.test(text) && RND_WORDS.test(text)) return 'core_tech_rnd';
  return null;
}

// ── 공고 연락처: 운영자 소유 도메인의 주소는 쓸 수 없다.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function contactEmailProblem(email: string | null | undefined, operatorDomains: string[]): string | null {
  if (!email) return 'contact_missing';
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return 'contact_invalid';
  const domain = e.slice(e.lastIndexOf('@') + 1);
  if (operatorDomains.some((d) => domain === d || domain.endsWith('.' + d))) return 'contact_is_operator';
  return null;
}

export function parseOperatorDomains(raw: string): string[] {
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ── 게재 가능 여부
export interface PublishInput {
  job: {
    job_family: 'office' | 'production';
    title_ko: string | null;
    body_ko: string | null;
    localize_status: 'draft' | 'review' | 'approved';
    contact_email: string | null;
    salary_basis: string | null;
    salary_min: number | null;
    agency_id: string | null;
    review_flag: string | null;
    review_cleared_by: string | null;
  };
  companyVerified: boolean;
  agencyVerified: boolean; // agency_id 가 없으면 무시
  flags: Flags;
  appEnv: 'dev' | 'test' | 'production';
  registrationNo: string;
  operatorDomains: string[];
}

export type PublishBlock =
  | 'company_not_verified'
  | 'agency_posting_disabled'
  | 'agency_not_verified'
  | 'production_jobs_disabled'
  | 'not_registered'
  | 'missing_content'
  | 'localization_not_approved'
  | 'salary_basis_missing'
  | 'banned_phrase'
  | 'needs_admin_review'
  | 'contact_missing'
  | 'contact_invalid'
  | 'contact_is_operator';

/** 빈 배열이면 게재할 수 있다. 하나라도 있으면 status 를 published 로 바꾸면 안 된다. */
export function publishBlocks(i: PublishInput): PublishBlock[] {
  const out: PublishBlock[] = [];
  const { job } = i;
  if (!i.companyVerified) out.push('company_not_verified');
  if (job.agency_id) {
    if (!i.flags.headhunterPosting) out.push('agency_posting_disabled');
    else if (!i.agencyVerified) out.push('agency_not_verified');
  }
  if (job.job_family === 'production' && !i.flags.productionJobs) out.push('production_jobs_disabled');
  // 신고번호가 없으면 운영 환경에서는 실제 공고를 게재하지 않는다.
  if (i.appEnv === 'production' && !i.registrationNo.trim()) out.push('not_registered');
  if (!job.title_ko?.trim() || !job.body_ko?.trim()) out.push('missing_content');
  if (job.localize_status !== 'approved') out.push('localization_not_approved');
  if (job.salary_min != null && !job.salary_basis) out.push('salary_basis_missing');
  const text = `${job.title_ko ?? ''}\n${job.body_ko ?? ''}`;
  if (findBannedPhrases(text).length) out.push('banned_phrase');
  if (job.review_flag && !job.review_cleared_by) out.push('needs_admin_review');
  const c = contactEmailProblem(job.contact_email, i.operatorDomains);
  if (c) out.push(c as PublishBlock);
  return out;
}

// ── 지원 상태: "상태 변경" 버튼은 없다. 기업이 편의 기능을 쓰면 이벤트가 남고, 상태는 이벤트에서만 나온다.
export type AppStatus = 'submitted' | 'viewed' | 'reviewing' | 'interview' | 'rejected' | 'closed' | 'withdrawn';
export type AppEvent = 'viewed' | 'summary_shared' | 'interview_mail' | 'reject_mail' | 'auto_closed' | 'withdrawn';

const RANK: Record<AppStatus, number> = { submitted: 0, viewed: 1, reviewing: 2, interview: 3, rejected: 9, closed: 9, withdrawn: 9 };
const EVENT_TO: Record<AppEvent, AppStatus> = {
  viewed: 'viewed',
  summary_shared: 'reviewing',
  interview_mail: 'interview',
  reject_mail: 'rejected',
  auto_closed: 'closed',
  withdrawn: 'withdrawn',
};

/** 끝난 지원(rejected/closed/withdrawn)은 바뀌지 않고, 진행 중인 지원은 뒤로 가지 않는다. */
export function nextStatus(current: AppStatus, event: AppEvent): AppStatus {
  if (RANK[current] === 9) return current;
  const target = EVENT_TO[event];
  return RANK[target] > RANK[current] ? target : current;
}
