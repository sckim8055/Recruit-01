// 권한 판단. 순수 함수 — 누가 무엇을 볼 수 있는지는 전부 여기서 정한다 (docs/ARCHITECTURE.md 3장 권한표).
import type { Role } from '../env';

export interface Actor {
  id: string;
  role: Role;
  companyIds: string[];              // 소속 기업
  hqCompanyIds: string[];            // 그중 중국 본사 소속으로 등록된 기업
  agencyIds: string[];
}

export interface JobRef { company_id: string; agency_id: string | null; created_by: string }

/** 공고를 수정·마감할 수 있는가. 관리자는 내용 수정 불가 (차단만 가능 → canBlockJob). */
export function canEditJob(a: Actor, job: JobRef): boolean {
  if (a.role === 'company') return job.agency_id === null && a.companyIds.includes(job.company_id);
  if (a.role === 'headhunter') return job.agency_id !== null && a.agencyIds.includes(job.agency_id);
  return false;
}

export const canBlockJob = (a: Actor): boolean => a.role === 'admin';
export const canApply = (a: Actor): boolean => a.role === 'seeker';

export interface ApplicationRef {
  seeker_id: string;
  job: JobRef;
  cross_border_consent_at: number | null;
  /** 지원 상태. 'withdrawn'(구직자가 취소) 이면 본인 말고는 아무도 볼 수 없다. */
  status: string;
}

export type ViewDecision =
  | { allow: true; needsReason: boolean }
  | { allow: false; why: 'not_related' | 'no_cross_border_consent' | 'withdrawn' };

/**
 * 지원서(이력서 복사본)를 볼 수 있는가.
 * - 구직자: 본인 것만
 * - 기업 담당자: 자기 기업의 직접 공고. 본사 소속 담당자는 국외 이전 동의가 있어야 한다
 * - 헤드헌터: 자기 업체가 올린 공고
 * - 관리자: 사유를 입력해야 열린다 (needsReason). 호출부는 access_log 에 사유를 남긴다
 * - 구직자가 취소한 지원(withdrawn)은 본인 말고는 아무도 볼 수 없다 (기업·헤드헌터·관리자 모두). 취소할 때 내용도 지운다.
 * 열람이 허용되면 호출부는 반드시 access_log 에 기록한다.
 */
export function canViewApplication(a: Actor, app: ApplicationRef): ViewDecision {
  if (a.role === 'seeker') {
    return a.id === app.seeker_id ? { allow: true, needsReason: false } : { allow: false, why: 'not_related' };
  }
  if (app.status === 'withdrawn') return { allow: false, why: 'withdrawn' };
  if (a.role === 'admin') return { allow: true, needsReason: true };
  if (a.role === 'company') {
    if (app.job.agency_id !== null || !a.companyIds.includes(app.job.company_id)) return { allow: false, why: 'not_related' };
    if (a.hqCompanyIds.includes(app.job.company_id) && app.cross_border_consent_at === null) {
      return { allow: false, why: 'no_cross_border_consent' };
    }
    return { allow: true, needsReason: false };
  }
  if (a.role === 'headhunter') {
    return app.job.agency_id !== null && a.agencyIds.includes(app.job.agency_id)
      ? { allow: true, needsReason: false }
      : { allow: false, why: 'not_related' };
  }
  return { allow: false, why: 'not_related' };
}

/** 중국어 요약본은 구직자가 승인한 뒤에만 기업에 보인다. */
export function canSeeZhSummary(a: Actor, app: ApplicationRef & { summary_approved_at: number | null }): boolean {
  if (a.role === 'seeker') return a.id === app.seeker_id;
  const v = canViewApplication(a, app);
  return v.allow && app.summary_approved_at !== null && app.cross_border_consent_at !== null;
}

// ── 기업·검증 서류

/** 기업 정보를 고치고 서류를 올릴 수 있는가: 그 기업의 담당자만. 관리자는 승인·반려만 한다. */
export function canManageCompany(a: Actor, companyId: string): boolean {
  return a.role === 'company' && a.companyIds.includes(companyId);
}

/** 담당자를 초대·삭제할 수 있는가: 그 기업의 대표 담당자(owner)만. */
export function canManageMembers(a: Actor, companyId: string, memberRole: 'owner' | 'member' | null): boolean {
  return canManageCompany(a, companyId) && memberRole === 'owner';
}

export interface VerificationDocRef { owner_type: 'company' | 'agency'; owner_id: string }

/**
 * 검증 서류(사업자등록증 등)를 볼 수 있는가: 올린 쪽 담당자와 관리자만.
 * 허용되면 호출부는 access_log 에 기록한다 (files.ts 의 serveVerificationDoc 이 한다).
 */
export function canViewVerificationDoc(a: Actor, doc: VerificationDocRef): boolean {
  if (a.role === 'admin') return true;
  if (doc.owner_type === 'company') return a.role === 'company' && a.companyIds.includes(doc.owner_id);
  return a.role === 'headhunter' && a.agencyIds.includes(doc.owner_id);
}

// ── 이력서 원본 (구직자가 저장해 둔 이력서)

export interface ResumeRef { user_id: string }

/**
 * 이력서 원본(resumes)을 볼 수 있는가.
 * - 구직자: 본인 것만
 * - 관리자: 사유를 입력해야 열린다 (needsReason). 호출부는 access_log 에 사유를 남긴다
 * - 기업 담당자·헤드헌터: 볼 수 없다. 기업이 보는 것은 구직자가 직접 지원해서 생긴 지원서(복사본)뿐이다
 *   (canViewApplication). 지원하지 않은 구직자의 이력서는 누구에게도 넘어가지 않는다 (CLAUDE.md 규칙 1).
 * 첨부파일을 내려줄 때는 호출부가 access_log 에 기록한다 (lib/resume-files.serveResumeFile).
 */
export function canViewResume(a: Actor, r: ResumeRef): ViewDecision {
  if (a.role === 'seeker') {
    return a.id === r.user_id ? { allow: true, needsReason: false } : { allow: false, why: 'not_related' };
  }
  if (a.role === 'admin') return { allow: true, needsReason: true };
  return { allow: false, why: 'not_related' };
}

/** 이력서를 만들고 고치고 지울 수 있는가: 구직자 본인만. 관리자도 고칠 수 없다. */
export function canEditResume(a: Actor, r: ResumeRef): boolean {
  return a.role === 'seeker' && a.id === r.user_id;
}
