// 파일 업로드·내려받기 (R2 비공개 버킷). 검증 서류와 이력서 첨부가 이 파일을 거친다.
// 원칙: ① 파일 종류는 확장자가 아니라 내용(앞부분 바이트)으로 판단한다 ② R2 키에 원래 파일명을 쓰지 않는다
//       ③ 내려받기는 항상 권한 확인 → 열람 기록 → 전송 순서이며, 공개 주소를 만들지 않는다.
// (기술설계서는 "5분 서명 URL"이었지만, 서명 URL 은 주소가 새면 권한 없이 열린다. Worker 가 권한을 확인한 뒤 직접 전송한다.)
import { now, type Env } from '../env';
import { canViewVerificationDoc, type Actor } from './authz';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DOC_TYPES = ['biz_cert', 'cn_license', 'agency_license'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface Sniffed { ext: 'pdf' | 'jpg' | 'png'; mime: string }

/** 파일 앞부분으로 종류를 판별한다. PDF·JPEG·PNG 만 받는다. */
export function sniffType(head: Uint8Array): Sniffed | null {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) return { ext: 'pdf', mime: 'application/pdf' };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return { ext: 'png', mime: 'image/png' };
  }
  return null;
}

export type UploadCheck =
  | { ok: true; bytes: ArrayBuffer; type: Sniffed }
  | { ok: false; why: 'empty' | 'too_large' | 'bad_type' };

export async function checkUpload(file: unknown): Promise<UploadCheck> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, why: 'empty' };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, why: 'too_large' };
  const bytes = await file.arrayBuffer();
  const type = sniffType(new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)));
  return type ? { ok: true, bytes, type } : { ok: false, why: 'bad_type' };
}

export const isDocType = (v: unknown): v is DocType => typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v);

/** 검증 서류를 저장한다. 권한(canManageCompany 등)은 호출부가 먼저 확인한다. */
export async function putVerificationDoc(
  env: Env, ownerType: 'company' | 'agency', ownerId: string, docType: DocType, up: { bytes: ArrayBuffer; type: Sniffed },
): Promise<string> {
  const id = crypto.randomUUID();
  const key = `vdocs/${ownerType}/${ownerId}/${id}.${up.type.ext}`;
  await env.FILES.put(key, up.bytes, { httpMetadata: { contentType: up.type.mime } });
  await env.DB.prepare(
    'INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, created_at) VALUES (?,?,?,?,?,?,?)',
  ).bind(id, ownerType, ownerId, docType, key, 'pending', now()).run();
  return id;
}

export async function logAccess(
  env: Env, actor: Actor, targetType: 'application' | 'resume' | 'verification_doc', targetId: string, reason: string | null,
): Promise<void> {
  await env.DB.prepare('INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES (?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), actor.id, actor.role, targetType, targetId, reason, now()).run();
}

/** 비공개 파일 응답에 붙이는 헤더: 캐시 금지, 종류 추측 금지, 문서 안의 스크립트 실행 금지. */
export function privateFileHeaders(mime: string, filename: string): Headers {
  return new Headers({
    'content-type': mime,
    'content-disposition': `${mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
}

/** 검증 서류를 내려준다: 권한 확인 → 열람 기록 → 전송. 볼 수 없거나 없으면 null (호출부는 404 로 응답한다). */
export async function serveVerificationDoc(env: Env, actor: Actor, docId: string): Promise<Response | null> {
  const doc = await env.DB.prepare('SELECT id, owner_type, owner_id, r2_key FROM verification_docs WHERE id = ?')
    .bind(docId).first<{ id: string; owner_type: 'company' | 'agency'; owner_id: string; r2_key: string }>();
  // 없는 것과 권한 없는 것을 구분해 알려주지 않는다.
  if (!doc || !canViewVerificationDoc(actor, doc)) return null;
  const obj = await env.FILES.get(doc.r2_key);
  if (!obj) return null;
  await logAccess(env, actor, 'verification_doc', doc.id, null);
  const ext = doc.r2_key.slice(doc.r2_key.lastIndexOf('.') + 1);
  return new Response(obj.body, { headers: privateFileHeaders(obj.httpMetadata?.contentType ?? 'application/octet-stream', `document.${ext}`) });
}
