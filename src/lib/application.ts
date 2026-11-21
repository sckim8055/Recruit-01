// 지원: 지원 가능 여부, 국외 이전 동의 필요 여부, 지원서(이력서 복사본) 만들기, 취소. 순수 함수 + Web Crypto — test/application.test.ts.
//
// 원칙 (CLAUDE.md 규칙 1·3·4·5)
// - 지원은 구직자 본인의 요청으로만 생긴다. 운영자·시스템이 대신 지원시키거나 이력서를 넘기는 길은 없다.
// - 기업이 받는 것은 지원 시점의 복사본(resume_snapshot)이다. 구직자가 저장해 둔 이력서 원본은 기업에 넘어가지 않는다.
//   복사본도 이력서와 같은 형식(ResumeBody)으로 통째로 암호화한다.
// - 상태는 이벤트로만 바뀐다 (rules.nextStatus). 취소도 'withdrawn' 이벤트다.
// - 취소하면 복사본과 첨부파일을 바로 지운다. 지원했다는 기록(행)만 남는다.
import type { AppStatus } from './rules';
import { nextStatus } from './rules';
import type { ResumeBody } from './resume';

/** 국외 이전 동의 문구의 판(版). 문구를 바꾸면 이 값을 올린다 (consents.version 에 남는다). 문구는 T-11 에서 운영자가 확정한다. */
export const CROSS_BORDER_VERSION = '2026-11-draft';

// ── 국외 이전 동의

export type ConsentNeed = 'none' | 'optional' | 'required';

/**
 * 이 기업에 지원할 때 국외 이전 동의가 필요한가.
 * - 중국 본사 소속 담당자가 없으면: 필요 없음 (지원서가 국외로 나가지 않는다)
 * - 본사 소속 담당자만 있으면: 필수 (동의가 없으면 아무도 지원서를 볼 수 없어 지원이 의미가 없다)
 * - 본사·한국 담당자가 함께 있으면: 선택 (동의하지 않으면 한국 담당자만 본다 — authz.canViewApplication)
 */
export function consentNeed(m: { hqMembers: number; localMembers: number }): ConsentNeed {
  if (m.hqMembers <= 0) return 'none';
  return m.localMembers > 0 ? 'optional' : 'required';
}

// ── 지원 가능 여부

export type ApplyBlock = 'not_seeker' | 'job_not_open' | 'already_applied' | 'resume_not_ready' | 'consent_required';

export interface ApplyInput {
  canApply: boolean;          // authz.canApply(actor)
  jobVisible: boolean;        // lib/public-jobs.isPubliclyVisible — 지금 공개 목록에 보이는 공고만 지원할 수 있다
  alreadyApplied: boolean;    // 같은 공고에 지원한 적이 있다 (취소한 경우 포함 — 다시 지원할 수 없다)
  resumeReady: boolean;       // lib/resume.resumeReadyToApply(복사본)
  consentNeed: ConsentNeed;
  consentGiven: boolean;
}

/** 빈 배열이면 지원할 수 있다. */
export function applyBlocks(i: ApplyInput): ApplyBlock[] {
  const out: ApplyBlock[] = [];
  if (!i.canApply) out.push('not_seeker');
  if (!i.jobVisible) out.push('job_not_open');
  if (i.alreadyApplied) out.push('already_applied');
  if (!i.resumeReady) out.push('resume_not_ready');
  if (i.consentNeed === 'required' && !i.consentGiven) out.push('consent_required');
  return out;
}

/** 저장할 동의 시각: 동의가 필요 없는 기업이면 체크했더라도 남기지 않는다 (필요하지 않은 동의를 받아 두지 않는다). */
export function consentAt(need: ConsentNeed, given: boolean, ts: number): number | null {
  return need !== 'none' && given ? ts : null;
}

// ── 지원서(복사본)

/**
 * 지원서에 들어갈 내용. 이력서에서 이번 지원에만 고친 항목(fields)을 쓰고,
 * 첨부파일은 넣기로 했고 실제로 복사된 경우에만 정보를 남긴다 (복사 실패·"첨부 제외" 는 null).
 */
export function buildSnapshot(
  base: ResumeBody, fields: Omit<ResumeBody, 'v' | 'file'>, file: { include: boolean; copied: boolean },
): ResumeBody {
  return { v: 1, ...fields, file: file.include && file.copied ? base.file : null };
}

// ── 취소

const ALL_STATUSES: AppStatus[] = ['submitted', 'viewed', 'reviewing', 'interview', 'rejected', 'closed', 'withdrawn'];

/** 취소할 수 있는 상태 (rules.nextStatus 가 'withdrawn' 으로 보내 주는 상태 = 진행 중인 지원). */
export const WITHDRAWABLE: AppStatus[] = ALL_STATUSES.filter((s) => s !== 'withdrawn' && nextStatus(s, 'withdrawn') === 'withdrawn');

export const canWithdraw = (status: string): boolean => (WITHDRAWABLE as string[]).includes(status);

// ── 기업 알림 메일 (개인정보 없음: 공고 제목과 주소만)

export function newApplicantMail(job: { title_ko: string | null }, origin: string, tr: (l: 'ko' | 'zh', key: string) => string): { subject: string; text: string } {
  const url = `${origin.replace(/\/+$/, '')}/biz`;
  const title = (job.title_ko ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const fill = (l: 'ko' | 'zh', key: string) => tr(l, key).replaceAll('{site}', tr(l, 'site.name')).replaceAll('{url}', url).replaceAll('{job}', title);
  return {
    subject: `[${tr('ko', 'site.name')}] ${fill('ko', 'mail.applicant.subject')} / ${fill('zh', 'mail.applicant.subject')}`,
    text: `${fill('ko', 'mail.applicant.body')}\n\n----------------------------------------\n\n${fill('zh', 'mail.applicant.body')}`,
  };
}
