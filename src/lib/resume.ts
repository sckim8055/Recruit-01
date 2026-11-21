// 이력서 내용: 항목 검사와 암호화 저장 형식. 순수 함수 + Web Crypto (DB·R2 접근 없음) — test/resume.test.ts 로 검증한다.
//
// 저장 형식: resumes.body = encryptText(JSON.stringify(ResumeBody)). 이름·연락처를 포함한 모든 항목이 암호문 안에 있다.
// 첨부파일의 원래 파일명·종류·크기도 이 JSON 안에 둔다 (파일명에 이름이 들어 있는 경우가 많다).
// 평문으로 남는 것은 resumes.title(구직자가 붙인 이름표)과 file_r2_key(무작위 키)뿐이다. title 에는 개인정보를 쓰지 말라고 화면에서 안내한다.
//
// 번역 엔진에 보낼 수 있는 항목은 translatableFields() 가 정한다: headline·experience_text·desired_role·chinese_level·years.
// 이름·연락처·첨부파일은 어떤 경우에도 엔진으로 보내지 않는다 (CLAUDE.md 규칙 6).
import { decryptText, encryptText } from './crypto';

export const RESUME_MAX_PER_USER = 5;
export const RESUME_LIMITS = { title: 40, name: 40, headline: 100, phone: 30, desired_role: 60, experience_text: 4000, email: 254, years: 60 } as const;
export const RESUME_CHINESE_LEVELS = ['none', 'basic', 'business', 'native'] as const;
export type ResumeChineseLevel = (typeof RESUME_CHINESE_LEVELS)[number];

export interface ResumeFileMeta {
  name: string;                 // 원래 파일명 (표시·내려받기용). 경로·제어 문자는 뺀다
  ext: 'pdf' | 'docx';
  mime: string;
  size: number;                 // 원본(암호화 전) 크기
}

export interface ResumeBody {
  v: 1;
  name: string;
  chinese_level: ResumeChineseLevel;
  years: number;                // 총 경력 연차 (0 = 신입)
  headline: string;
  contact_email: string;
  phone: string | null;
  desired_role: string | null;
  experience_text: string | null;
  file: ResumeFileMeta | null;
}

export type ResumeField = 'title' | 'name' | 'chinese_level' | 'years' | 'headline' | 'contact_email' | 'phone' | 'desired_role' | 'experience_text';
export interface ResumeFieldError { field: ResumeField; code: 'required' | 'too_long' | 'invalid' }

/** 폼에서 온 값 그대로 (다시 그릴 때 쓴다). */
export interface ResumeInput {
  title: string; name: string; chinese_level: string; years: string; headline: string;
  contact_email: string; phone: string; desired_role: string; experience_text: string;
}

export const EMPTY_RESUME_INPUT: ResumeInput = {
  title: '', name: '', chinese_level: '', years: '', headline: '', contact_email: '', phone: '', desired_role: '', experience_text: '',
};

const str = (f: Record<string, unknown>, k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
/** 한 줄 항목: 줄바꿈·제어 문자를 공백으로 바꾸고 앞뒤 공백을 뺀다. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
/** 여러 줄 항목: 줄바꿈은 \n 으로 맞추고, 그 밖의 제어 문자는 뺀다. */
const multiLine = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
/** 전화번호: 숫자·공백·+·-·() 만, 숫자는 7~15개. 형식을 강제하지 않는다 (한국·중국 번호 모두 받는다). */
const PHONE_RE = /^[0-9+\-() ]+$/;

export function readResumeForm(f: Record<string, unknown>): ResumeInput {
  return {
    title: oneLine(str(f, 'title')), name: oneLine(str(f, 'name')), chinese_level: str(f, 'chinese_level').trim(),
    years: str(f, 'years').trim(), headline: oneLine(str(f, 'headline')), contact_email: str(f, 'contact_email').trim().toLowerCase(),
    phone: oneLine(str(f, 'phone')), desired_role: oneLine(str(f, 'desired_role')), experience_text: multiLine(str(f, 'experience_text')),
  };
}

export type ResumeValidation =
  | { ok: true; title: string; fields: Omit<ResumeBody, 'v' | 'file'> }
  | { ok: false; errors: ResumeFieldError[] };

/**
 * 폼 검사. 필수는 다섯 개(이름·중국어 수준·경력 연차·한 줄 소개·연락 이메일)와 이력서 이름표(title)뿐이다.
 * 첨부파일은 여기서 다루지 않는다 (lib/resume-files.checkResumeUpload).
 */
export function validateResume(i: ResumeInput): ResumeValidation {
  const errors: ResumeFieldError[] = [];
  const err = (field: ResumeField, code: ResumeFieldError['code']) => { errors.push({ field, code }); };
  const text = (field: Exclude<ResumeField, 'chinese_level' | 'years'>, required: boolean): string | null => {
    const v = i[field];
    if (!v) { if (required) err(field, 'required'); return null; }
    if (v.length > RESUME_LIMITS[field === 'contact_email' ? 'email' : field]) { err(field, 'too_long'); return null; }
    return v;
  };

  const title = text('title', true);
  const name = text('name', true);
  const headline = text('headline', true);
  const contact_email = text('contact_email', true);
  if (contact_email && !EMAIL_RE.test(contact_email)) err('contact_email', 'invalid');
  const phone = text('phone', false);
  if (phone && (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15)) err('phone', 'invalid');
  const desired_role = text('desired_role', false);
  const experience_text = text('experience_text', false);

  let chinese_level: ResumeChineseLevel | null = null;
  if (!i.chinese_level) err('chinese_level', 'required');
  else if ((RESUME_CHINESE_LEVELS as readonly string[]).includes(i.chinese_level)) chinese_level = i.chinese_level as ResumeChineseLevel;
  else err('chinese_level', 'invalid');

  let years: number | null = null;
  if (!i.years) err('years', 'required');
  else if (/^\d{1,2}$/.test(i.years) && Number(i.years) <= RESUME_LIMITS.years) years = Number(i.years);
  else err('years', 'invalid');

  if (errors.length || !title || !name || !headline || !contact_email || chinese_level === null || years === null) {
    return { ok: false, errors };
  }
  return { ok: true, title, fields: { name, chinese_level, years, headline, contact_email, phone, desired_role, experience_text } };
}

/** 저장된 이력서를 폼 값으로 되돌린다 (편집 화면). */
export function inputFromResume(title: string, b: ResumeBody): ResumeInput {
  return {
    title, name: b.name, chinese_level: b.chinese_level, years: String(b.years), headline: b.headline, contact_email: b.contact_email,
    phone: b.phone ?? '', desired_role: b.desired_role ?? '', experience_text: b.experience_text ?? '',
  };
}

// ── 암호화 저장

export async function sealResume(key: CryptoKey, body: ResumeBody): Promise<string> {
  return encryptText(key, JSON.stringify(body));
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): string | null => (isStr(v) && v ? v : null);

/**
 * 암호문을 풀어 이력서 내용으로 되돌린다. 복호화에 실패하거나(키가 다름·값이 변조됨) 모양이 맞지 않으면 예외를 던진다.
 * 호출부는 이 예외를 "이력서를 열 수 없음" 으로 처리하고, 예외 내용을 화면·로그에 내보내지 않는다.
 */
export async function openResume(key: CryptoKey, stored: string): Promise<ResumeBody> {
  const raw: unknown = JSON.parse(await decryptText(key, stored));
  if (typeof raw !== 'object' || raw === null) throw new Error('resume: bad shape');
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !isStr(o.name) || !isStr(o.headline) || !isStr(o.contact_email) || typeof o.years !== 'number'
    || !isStr(o.chinese_level) || !(RESUME_CHINESE_LEVELS as readonly string[]).includes(o.chinese_level)) {
    throw new Error('resume: bad shape');
  }
  let file: ResumeFileMeta | null = null;
  if (typeof o.file === 'object' && o.file !== null) {
    const f = o.file as Record<string, unknown>;
    if (!isStr(f.name) || (f.ext !== 'pdf' && f.ext !== 'docx') || !isStr(f.mime) || typeof f.size !== 'number') throw new Error('resume: bad file meta');
    file = { name: f.name, ext: f.ext, mime: f.mime, size: f.size };
  }
  return {
    v: 1, name: o.name, chinese_level: o.chinese_level as ResumeChineseLevel, years: o.years, headline: o.headline,
    contact_email: o.contact_email, phone: strOrNull(o.phone), desired_role: strOrNull(o.desired_role),
    experience_text: strOrNull(o.experience_text), file,
  };
}

// ── 판단

/** 지원에 쓸 수 있는 이력서인가: 첨부파일이나 경력 요약 중 하나는 있어야 한다 (ARCHITECTURE 4장). T-08 이 쓴다. */
export const resumeReadyToApply = (b: ResumeBody): boolean => b.file !== null || !!b.experience_text?.trim();

/** 번역 엔진에 보낼 수 있는 항목만 고른다. 이름·연락처·첨부파일 정보는 들어가지 않는다 (CLAUDE.md 규칙 6). */
export function translatableFields(b: ResumeBody): { headline: string; experience_text: string | null; desired_role: string | null; chinese_level: ResumeChineseLevel; years: number } {
  return { headline: b.headline, experience_text: b.experience_text, desired_role: b.desired_role, chinese_level: b.chinese_level, years: b.years };
}

/** 복사본의 이름표: "원래 이름 (복사)" — 길이 제한을 넘지 않게 자른다. */
export function copyTitle(title: string, suffix: string): string {
  const s = ` ${suffix}`;
  return title.slice(0, Math.max(1, RESUME_LIMITS.title - s.length)) + s;
}
