// 지원서를 본인 아닌 사람(기업 담당자·헤드헌터·관리자)이 여는 **유일한 길**. T-09.
//
// 순서는 바꾸지 않는다: ① 권한(authz.canViewApplication) → ② 관리자는 사유 확인 → ③ 복호화 → ④ 열람 기록(access_log)
//                      → ⑤ 기업·헤드헌터가 처음 열었으면 'viewed' 이벤트로 상태 변경 (rules.nextStatus).
// 복호화보다 기록을 먼저 하지 않는 이유: 열 수 없는(손상된) 지원서는 내용이 나가지 않으므로 열람으로 남기지 않는다.
// 기록에 실패하면 내용을 돌려주지 않는다 (기록 없는 열람을 만들지 않는다).
//
// 화면·라우트는 getApplicationWithJob 으로 읽은 행을 이 함수에 넘기고, 돌려받은 body 만 화면에 쓴다.
// resume_snapshot 을 다른 곳에서 직접 복호화하지 않는다.
import { now, type Env } from '../env';
import { canViewApplication, type Actor, type ApplicationRef } from './authz';
import { importEncKey } from './crypto';
import { logAccess } from './files';
import { openResume, type ResumeBody } from './resume';
import { nextStatus, type AppStatus } from './rules';
import { markViewed, type ApplicationWithJob } from '../db/applicants';

export const ADMIN_REASON_MAX = 300;

export const refOf = (a: ApplicationWithJob): ApplicationRef => ({
  seeker_id: a.seeker_id,
  job: { company_id: a.company_id, agency_id: a.agency_id, created_by: a.job_created_by },
  cross_border_consent_at: a.cross_border_consent_at,
  status: a.status,
});

/** 관리자 사유: 앞뒤 공백을 빼고 1~300자, 줄바꿈은 공백으로. 비어 있으면 null. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s && s.length <= ADMIN_REASON_MAX ? s : null;
}

export type OpenResult =
  | { ok: true; body: ResumeBody; status: string; needsReason: boolean }
  | { ok: false; why: 'forbidden' | 'no_cross_border_consent' | 'withdrawn' | 'reason_required' | 'unreadable' };

/** 본인 아닌 사람이 지원서를 연다. 본인(구직자)이 자기 지원서를 보는 것은 이 함수의 일이 아니다 (routes/applications.tsx). */
export async function openApplication(env: Env, actor: Actor, app: ApplicationWithJob, reason: string | null): Promise<OpenResult> {
  if (actor.role === 'seeker') return { ok: false, why: 'forbidden' };
  const d = canViewApplication(actor, refOf(app));
  if (!d.allow) return { ok: false, why: d.why === 'not_related' ? 'forbidden' : d.why };
  const why = d.needsReason ? cleanReason(reason) : null;
  if (d.needsReason && !why) return { ok: false, why: 'reason_required' };

  let body: ResumeBody;
  try {
    if (!app.resume_snapshot) return { ok: false, why: 'unreadable' };
    body = await openResume(await importEncKey(env.ENC_KEY), app.resume_snapshot);
  } catch {
    return { ok: false, why: 'unreadable' };
  }

  await logAccess(env, actor, 'application', app.id, why);

  // 기업·헤드헌터가 열면 구직자 쪽 상태가 "열람함" 으로 넘어간다. 관리자의 열람은 상태를 바꾸지 않는다.
  let status = app.status;
  if (actor.role === 'company' || actor.role === 'headhunter') {
    const to = nextStatus(app.status as AppStatus, 'viewed');
    if (to !== app.status && await markViewed(env.DB, { id: app.id, actorId: actor.id, from: app.status, to, ts: now() })) status = to;
  }
  return { ok: true, body, status, needsReason: d.needsReason };
}
