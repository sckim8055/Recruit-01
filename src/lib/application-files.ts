// 지원서 첨부파일 내려받기: 권한 확인(authz.canViewApplication) → 열람 기록 → 복호화 → 전송.
// 파일 자체의 저장·암호화는 이력서 첨부와 같다 (lib/resume-files.ts). 지원서는 지원할 때 복사한 자기 파일을 가진다.
import type { Env } from '../env';
import { canViewApplication, type Actor, type ApplicationRef } from './authz';
import { logAccess, privateFileHeaders } from './files';
import type { ResumeFileMeta } from './resume';
import { readResumeFile, rfc5987 } from './resume-files';

/**
 * 볼 수 없거나 파일이 없으면 null (호출부는 404). 관리자는 사유가 있어야 열린다.
 * 취소된 지원·국외 이전 동의가 없는 본사 담당자 등은 canViewApplication 이 막는다.
 * 항상 "저장"(attachment)으로 내려준다.
 */
export async function serveApplicationFile(
  env: Env, actor: Actor, app: ApplicationRef & { id: string; file_r2_key: string | null }, meta: ResumeFileMeta | null, reason: string | null,
): Promise<Response | null> {
  const d = canViewApplication(actor, app);
  if (!d.allow || !app.file_r2_key || !meta) return null;
  const why = reason?.trim() || null;
  if (d.needsReason && !why) return null;
  let plain: Uint8Array | null;
  try {
    plain = await readResumeFile(env, app.file_r2_key);
  } catch {
    return null;
  }
  if (!plain) return null;
  await logAccess(env, actor, 'application', app.id, d.needsReason ? why : null);
  const headers = privateFileHeaders(meta.mime, `resume.${meta.ext}`);
  headers.set('content-disposition', `attachment; filename="resume.${meta.ext}"; filename*=UTF-8''${rfc5987(meta.name)}`);
  headers.set('content-length', String(plain.length));
  return new Response(plain, { headers });
}
