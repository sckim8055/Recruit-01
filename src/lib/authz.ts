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
}

export type ViewDecision =
  | { allow: true; needsReason: boolean }
  | { allow: false; why: 'not_related' | 'no_cross_border_consent' };

/**
 * 지원서(이력서 복사본)를 볼 수 있는가.
 * - 구직자: 본인 것만
 * - 기업 담당자: 자기 기업의 직접 공고. 본사 소속 담당자는 국외 이전 동의가 있어야 한다
 * - 헤드헌터: 자기 업체가 올린 공고
 * - 관리자: 사유를 입력해야 열린다 (needsReason). 호출부는 access_log 에 사유를 남긴다
 * 열람이 허용되면 호출부는 반드시 access_log 에 기록한다.
 */
export function canViewApplication(a: Actor, app: ApplicationRef): ViewDecision {
  if (a.role === 'seeker') {
    return a.id === app.seeker_id ? { allow: true, needsReason: false } : { allow: false, why: 'not_related' };
  }
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
