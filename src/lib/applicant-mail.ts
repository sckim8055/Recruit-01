// 기업 담당자가 지원자에게 보내는 메일: 면접 요청(자유 글)·불합격 통보(정해진 글). T-09b.
//
// 원칙
// - 보내는 사람은 그 공고의 기업 담당자(또는 헤드헌터)뿐이다. **관리자·운영자는 지원자에게 메일을 보낼 수 없다** (규칙 1: 채용 과정에 끼지 않는다).
// - 받는 주소는 지원서(복사본)의 연락 이메일이다. 이 함수 안에서만 풀어서 쓰고, 화면·로그·주소에 내보내지 않는다.
// - 면접 요청 글은 기업이 쓴 원문을 그대로 넣고, 번역이 있으면 "자동 번역" 이라고 밝혀 함께 넣는다. 시스템이 글을 고쳐 쓰지 않는다.
// - 답장 주소(Reply-To)는 보낸 담당자의 주소다. 운영자 주소를 연락처로 쓰지 않는다.
// - 상태는 이벤트로만 바뀐다: 'interview_mail' → interview, 'reject_mail' → rejected (rules.nextStatus).
// - 순서: 권한·상태·횟수 확인 → 복호화 → 메일 발송 → 이벤트·상태 기록. 메일이 나가지 않았으면 기록하지 않는다
//   (보내지 않은 면접 요청·불합격 통보가 구직자 화면에 뜨면 안 된다).
import { now, type Env } from '../env';
import { canViewApplication, type Actor } from './authz';
import { refOf } from './applicants';
import { importEncKey } from './crypto';
import { sendMail } from './email';
import { MESSAGE_MAX } from './localize/message';
import { openResume } from './resume';
import { nextStatus, type AppStatus } from './rules';
import { countEvents, recordMailEvent, type ApplicationWithJob } from '../db/applicants';

/** 한 지원에 보낼 수 있는 면접 요청 메일 수 (일정 변경 등으로 다시 보낼 수 있게 하되, 반복 발송은 막는다). */
export const INTERVIEW_MAIL_MAX = 3;
/** 한 번에 불합격 통보를 보낼 수 있는 지원 수 (요청 하나의 처리 한도 안에서 끝나게). */
export const REJECT_BATCH_MAX = 10;

type Tr = (l: 'ko' | 'zh', key: string) => string;

/** 메시지 폼: 줄바꿈은 \n, 제어 문자 제거, 1~2000자. */
export function readMessage(raw: unknown): { ok: true; text: string } | { ok: false; why: 'required' | 'too_long' } {
  const s = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!s) return { ok: false, why: 'required' };
  return s.length > MESSAGE_MAX ? { ok: false, why: 'too_long' } : { ok: true, text: s };
}

const oneLine = (s: string | null, max: number) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/** 면접 요청 메일. 구직자에게 가므로 한국어 안내문 + (자동 번역) + 원문. 번역이 없거나 원문과 같으면 원문만. */
export function interviewMail(
  p: { companyName: string; jobTitle: string | null; original: string; translationKo: string | null }, tr: Tr,
): { subject: string; text: string } {
  const v = { site: tr('ko', 'site.name'), company: oneLine(p.companyName, 80), job: oneLine(p.jobTitle, 120) };
  const tl = p.translationKo?.trim();
  const parts = [fill(tr('ko', 'mail.interview.intro'), v), ''];
  if (tl && tl !== p.original.trim()) {
    parts.push(tr('ko', 'mail.interview.translated'), tl, '', tr('ko', 'mail.interview.original'), p.original);
  } else {
    parts.push(tr('ko', 'mail.interview.message'), p.original);
  }
  parts.push('', '----------------------------------------', fill(tr('ko', 'mail.interview.footer'), v));
  return { subject: `[${v.site}] ${fill(tr('ko', 'mail.interview.subject'), v)}`, text: parts.join('\n') };
}

/** 불합격 통보 메일. 정해진 글만 쓴다 (기업이 사유를 적지 않는다). */
export function rejectMail(p: { companyName: string; jobTitle: string | null }, tr: Tr): { subject: string; text: string } {
  const v = { site: tr('ko', 'site.name'), company: oneLine(p.companyName, 80), job: oneLine(p.jobTitle, 120) };
  return { subject: `[${v.site}] ${fill(tr('ko', 'mail.reject.subject'), v)}`, text: fill(tr('ko', 'mail.reject.body'), v) };
}

export type MailResult =
  | { ok: true; status: string }
  | { ok: false; why: 'forbidden' | 'not_open' | 'limit' | 'unreadable' | 'mail_failed' | 'changed' };

/** 보낼 수 있는 사람인가: 그 지원서를 볼 수 있는 기업 담당자·헤드헌터. 관리자·구직자는 아니다. */
function senderAllowed(actor: Actor, app: ApplicationWithJob): boolean {
  if (actor.role !== 'company' && actor.role !== 'headhunter') return false;
  return canViewApplication(actor, refOf(app)).allow;
}

/** 지원서의 연락 이메일 (이 파일 안에서만 쓴다). 열 수 없으면 null. */
async function contactEmailOf(env: Env, app: ApplicationWithJob): Promise<string | null> {
  try {
    if (!app.resume_snapshot) return null;
    return (await openResume(await importEncKey(env.ENC_KEY), app.resume_snapshot)).contact_email || null;
  } catch {
    return null;
  }
}

/** 면접 요청을 보낸다. replyTo 는 보낸 담당자의 계정 이메일. */
export async function sendInterviewRequest(
  env: Env, actor: Actor, app: ApplicationWithJob,
  m: { companyName: string; original: string; translationKo: string | null; replyTo: string }, tr: Tr,
): Promise<MailResult> {
  if (!senderAllowed(actor, app)) return { ok: false, why: 'forbidden' };
  const to = nextStatus(app.status as AppStatus, 'interview_mail');
  if (to !== 'interview') return { ok: false, why: 'not_open' }; // 불합격·종료·취소된 지원에는 보낼 수 없다
  if (await countEvents(env.DB, app.id, 'interview_mail') >= INTERVIEW_MAIL_MAX) return { ok: false, why: 'limit' };
  const email = await contactEmailOf(env, app);
  if (!email) return { ok: false, why: 'unreadable' };
  const mail = interviewMail({ companyName: m.companyName, jobTitle: app.job_title_ko, original: m.original, translationKo: m.translationKo }, tr);
  if (!await sendMail(env, { to: email, template: 'interview_request', replyTo: m.replyTo, ...mail })) return { ok: false, why: 'mail_failed' };
  const done = await recordMailEvent(env.DB, { id: app.id, actorId: actor.id, event: 'interview_mail', from: app.status, to, maxSame: INTERVIEW_MAIL_MAX, ts: now() });
  // 메일은 나갔는데 그사이 상태가 바뀐 경우(취소 등): 기록되지 않았다고 알린다.
  return done ? { ok: true, status: to } : { ok: false, why: 'changed' };
}

/** 불합격 통보를 보낸다 (한 지원에 한 번 — 보내면 끝난 지원이 된다). */
export async function sendRejection(
  env: Env, actor: Actor, app: ApplicationWithJob, m: { companyName: string; replyTo: string }, tr: Tr,
): Promise<MailResult> {
  if (!senderAllowed(actor, app)) return { ok: false, why: 'forbidden' };
  const to = nextStatus(app.status as AppStatus, 'reject_mail');
  if (to !== 'rejected' || app.status === 'rejected') return { ok: false, why: 'not_open' };
  const email = await contactEmailOf(env, app);
  if (!email) return { ok: false, why: 'unreadable' };
  const mail = rejectMail({ companyName: m.companyName, jobTitle: app.job_title_ko }, tr);
  if (!await sendMail(env, { to: email, template: 'reject_notice', replyTo: m.replyTo, ...mail })) return { ok: false, why: 'mail_failed' };
  const done = await recordMailEvent(env.DB, { id: app.id, actorId: actor.id, event: 'reject_mail', from: app.status, to, maxSame: 1, ts: now() });
  return done ? { ok: true, status: to } : { ok: false, why: 'changed' };
}
