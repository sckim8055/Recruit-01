// 이력서 첨부파일: 종류 검사 → 암호화 → R2 비공개 저장, 그리고 권한 확인 → 열람 기록 → 복호화 → 전송.
//
// 검증 서류(lib/files.ts)와 다른 점
// - **Worker 에서 한 번 더 암호화한다.** 이력서 파일에는 주민번호·주소·사진이 들어 있을 수 있어, R2 버킷을 직접 열어도
//   내용이 보이지 않게 ENC_KEY 로 AES-GCM 암호화한 바이트만 저장한다. ENC_KEY 를 잃으면 복구할 수 없다.
// - R2 에는 파일 종류(contentType)·원래 파일명을 남기지 않는다. 그 정보는 암호화된 resumes.body 안에 있다 (lib/resume.ts).
// - 받는 종류는 PDF·DOCX 뿐이다. HWP·DOC·이미지는 받지 않는다 (화면에서 PDF 로 저장해 올리라고 안내).
// - 크기는 5MB 까지다. 기술설계서는 10MB 였지만, 무료 플랜의 요청당 CPU 한도 안에서 암호화·복호화를 끝내기 위해 줄였다.
//
// 저장 형식 (R2 객체 바이트): "RF1"(3바이트) + iv(12바이트) + AES-GCM 암호문(끝 16바이트는 인증 태그).
// 암호화할 때 R2 키 문자열을 추가 인증 데이터(AAD)로 넣는다 — 저장소 안에서 객체를 다른 키로 옮겨 놓으면 복호화가 실패한다
// (다른 사람의 파일로 바꿔치기하는 것을 막는다). 그래서 복사는 "풀고 → 새 키로 다시 암호화" 로 한다.
import type { Env } from '../env';
import { canViewResume, type Actor, type ResumeRef } from './authz';
import { importEncKey } from './crypto';
import { logAccess, privateFileHeaders, sniffType } from './files';
import type { ResumeFileMeta } from './resume';

export const RESUME_FILE_MAX_BYTES = 5 * 1024 * 1024;
const MAGIC = new Uint8Array([0x52, 0x46, 0x31]); // "RF1"
const IV_LEN = 12;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const enc = new TextEncoder();

/** bytes 안에 ASCII 문자열 needle 이 있는가 (from 부터). */
function hasAscii(bytes: Uint8Array, needle: string, from: number): boolean {
  const n = enc.encode(needle);
  outer: for (let i = Math.max(0, from); i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * 내용으로 종류를 판별한다 (확장자·브라우저가 보낸 종류는 믿지 않는다).
 * - PDF: "%PDF-" 로 시작
 * - DOCX: ZIP 으로 시작(PK\x03\x04)하고, 파일 끝의 목록(central directory)에 word/document.xml 이 있다.
 *   목록은 압축되지 않으므로 끝 64KB 만 본다. XLSX·PPTX·일반 ZIP 은 받지 않는다.
 */
export function sniffResumeFile(bytes: Uint8Array): { ext: 'pdf' | 'docx'; mime: string } | null {
  const head = sniffType(bytes.subarray(0, 8));
  if (head?.ext === 'pdf') return { ext: 'pdf', mime: head.mime };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    && hasAscii(bytes, 'word/document.xml', bytes.length - 65536)) {
    return { ext: 'docx', mime: DOCX_MIME };
  }
  return null;
}

/** 표시·내려받기용 파일명: 경로·제어 문자·따옴표를 빼고 80자로 자른다. 확장자는 판별한 종류로 맞춘다. */
export function safeFileName(original: string, ext: 'pdf' | 'docx'): string {
  const base = original.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|;%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'resume'}.${ext}`;
}

export type ResumeUploadCheck =
  | { ok: true; bytes: Uint8Array; meta: ResumeFileMeta }
  | { ok: false; why: 'empty' | 'too_large' | 'bad_type' };

/** 올린 파일 검사. 파일을 고르지 않은 경우(빈 File)는 'empty' — 호출부가 "첨부 없음" 으로 다룬다. */
export async function checkResumeUpload(file: unknown): Promise<ResumeUploadCheck> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, why: 'empty' };
  if (file.size > RESUME_FILE_MAX_BYTES) return { ok: false, why: 'too_large' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const t = sniffResumeFile(bytes);
  if (!t) return { ok: false, why: 'bad_type' };
  return { ok: true, bytes, meta: { name: safeFileName(file.name, t.ext), ext: t.ext, mime: t.mime, size: bytes.length } };
}

// ── 암호화 (순수: 키와 바이트만 받는다)

export async function encryptFile(key: CryptoKey, plain: Uint8Array, r2Key: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(r2Key) }, key, plain));
  const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_LEN);
  return out;
}

/** 형식이 다르거나, 키·R2 키가 다르거나, 바이트가 바뀌었으면 예외를 던진다. */
export async function decryptFile(key: CryptoKey, stored: Uint8Array, r2Key: string): Promise<Uint8Array> {
  if (stored.length < MAGIC.length + IV_LEN + 16 || stored[0] !== MAGIC[0] || stored[1] !== MAGIC[1] || stored[2] !== MAGIC[2]) {
    throw new Error('resume file: unknown format');
  }
  const iv = stored.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(r2Key) }, key, stored.subarray(MAGIC.length + IV_LEN));
  return new Uint8Array(pt);
}

/** RFC 5987 값 인코딩: encodeURIComponent 가 남겨 두는 ' ( ) * 도 바꾼다. */
export const rfc5987 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

// ── R2

/** 새 R2 키. 사용자 id·파일명을 넣지 않는다 (키만 보고는 누구 것인지 알 수 없게). */
export const newResumeFileKey = (): string => `rfiles/${crypto.randomUUID()}`;

/** 암호화해서 저장하고 R2 키를 돌려준다. 권한(canEditResume)은 호출부가 먼저 확인한다. */
export async function putResumeFile(env: Env, plain: Uint8Array): Promise<string> {
  const r2Key = newResumeFileKey();
  const sealed = await encryptFile(await importEncKey(env.ENC_KEY), plain, r2Key);
  await env.FILES.put(r2Key, sealed);
  return r2Key;
}

/** 저장된 파일을 풀어서 돌려준다. 없으면 null. 복호화 실패는 예외. 권한은 호출부가 먼저 확인한다. */
export async function readResumeFile(env: Env, r2Key: string): Promise<Uint8Array | null> {
  const obj = await env.FILES.get(r2Key);
  if (!obj) return null;
  return decryptFile(await importEncKey(env.ENC_KEY), new Uint8Array(await obj.arrayBuffer()), r2Key);
}

/** 복사 (이력서 복사, T-08 의 지원서 복사본). 원본이 없으면 null. */
export async function copyResumeFile(env: Env, r2Key: string): Promise<string | null> {
  const plain = await readResumeFile(env, r2Key);
  return plain ? putResumeFile(env, plain) : null;
}

/** 지운다. 없는 키를 지워도 오류가 아니다. rfiles/ 밖의 키는 건드리지 않는다. */
export async function deleteResumeFile(env: Env, r2Key: string | null): Promise<void> {
  if (r2Key && r2Key.startsWith('rfiles/')) await env.FILES.delete(r2Key);
}

/**
 * 이력서 첨부파일을 내려준다: 권한 확인 → 열람 기록 → 복호화 → 전송. 볼 수 없거나 없으면 null (호출부는 404).
 * 관리자는 사유(reason)가 있어야 열린다 — 사유가 없으면 null.
 * 항상 "저장"(attachment)으로 내려주고 브라우저 안에서 열지 않는다.
 */
export async function serveResumeFile(
  env: Env, actor: Actor, resume: ResumeRef & { id: string; file_r2_key: string | null }, meta: ResumeFileMeta | null, reason: string | null,
): Promise<Response | null> {
  const d = canViewResume(actor, resume);
  if (!d.allow || !resume.file_r2_key || !meta) return null;
  const why = reason?.trim() || null;
  if (d.needsReason && !why) return null;
  let plain: Uint8Array | null;
  try {
    plain = await readResumeFile(env, resume.file_r2_key);
  } catch {
    return null; // 복호화 실패: 내용을 내보내지 않는다
  }
  if (!plain) return null;
  await logAccess(env, actor, 'resume', resume.id, d.needsReason ? why : null);
  const headers = privateFileHeaders(meta.mime, `resume.${meta.ext}`);
  // 원래 파일명은 RFC 5987 형식으로 붙인다 (한글 파일명). 따옴표 안의 이름은 ASCII 고정값이다.
  headers.set('content-disposition', `attachment; filename="resume.${meta.ext}"; filename*=UTF-8''${rfc5987(meta.name)}`);
  headers.set('content-length', String(plain.length));
  return new Response(plain, { headers });
}
