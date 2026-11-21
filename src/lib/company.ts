// 기업 등록·편집 폼의 검사와 정규화, 검증 뒤 잠금 판단, 담당자·승인 폼 검사.
// 순수 함수만 둔다 (DB 접근 없음) — test/company-form.test.ts 로 검증한다.
// 승인 가능 여부 자체는 rules.verifyBlocks 가 정한다. 여기서는 입력값만 다룬다.
import { isValidBizNo } from './rules';

export const ENTITY_TYPES = ['kr_entity', 'cn_hq'] as const;
export const ENTRY_STAGES = ['preparing', 'just_established', 'operating'] as const;
/** 기업이 올릴 수 있는 서류 종류 (agency_license 는 헤드헌터 업체용이라 받지 않는다). */
export const COMPANY_DOC_TYPES = ['biz_cert', 'cn_license'] as const;
export const MAX_COMPANY_DOCS = 5;
/** 담당자 + 수락 대기 초대의 합계 한도. */
export const MAX_COMPANY_SEATS = 10;
export const REJECT_REASON_MAX = 500;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type EntryStage = (typeof ENTRY_STAGES)[number];
export type CompanyDocType = (typeof COMPANY_DOC_TYPES)[number];
export type VerifyStatus = 'pending' | 'verified' | 'rejected';

export interface CompanyFields {
  name_ko: string;
  name_zh: string | null;
  entity_type: EntityType;
  biz_no: string | null;          // 숫자 10자리만 저장 (kr_entity). cn_hq 는 null
  hq_name: string | null;
  entry_stage: EntryStage | null;
  industry: string | null;
  website: string | null;
  profile_ko: string | null;
}
export type CompanyField = keyof CompanyFields;
/** 폼에서 읽은 그대로의 값 (앞뒤 공백 제거, 없으면 빈 문자열). */
export type CompanyInput = Record<CompanyField, string>;

export const COMPANY_FIELDS: CompanyField[] = [
  'name_ko', 'name_zh', 'entity_type', 'biz_no', 'hq_name', 'entry_stage', 'industry', 'website', 'profile_ko',
];
/** 검증(승인) 뒤에는 바꿀 수 없는 신원 항목. */
export const IDENTITY_FIELDS = ['name_ko', 'name_zh', 'biz_no', 'entity_type'] as const satisfies readonly CompanyField[];

export const FIELD_MAX: Record<CompanyField, number> = {
  name_ko: 100, name_zh: 100, hq_name: 100, profile_ko: 2000,
  entity_type: 200, biz_no: 200, entry_stage: 200, industry: 200, website: 200,
};

export interface FieldError { field: CompanyField; code: 'required' | 'too_long' | 'invalid' }
export type CompanyCheck = { ok: true; value: CompanyFields } | { ok: false; errors: FieldError[] };

const str = (f: Record<string, unknown>, k: string): string => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
const orNull = (s: string): string | null => (s === '' ? null : s);
const isOneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** 폼 값을 읽는다. 등록 폼에는 기업 소개(profile_ko)가 없다. */
export function readCompanyForm(f: Record<string, unknown>, withProfile: boolean): CompanyInput {
  const out = {} as CompanyInput;
  for (const k of COMPANY_FIELDS) out[k] = k === 'profile_ko' && !withProfile ? '' : str(f, k);
  out.profile_ko = out.profile_ko.replace(/\r\n?/g, '\n');
  return out;
}

/** 저장된 값을 폼 값 모양으로 바꾼다 (편집 화면의 기본값, 잠긴 항목 덮어쓰기에 쓴다). */
export function inputFromFields(c: CompanyFields): CompanyInput {
  const out = {} as CompanyInput;
  for (const k of COMPANY_FIELDS) out[k] = c[k] ?? '';
  return out;
}

/** http·https 주소만 받는다 (javascript: 등은 거부). */
export function isHttpUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** 사업자등록번호에서 숫자만 남긴다 (하이픈·공백 허용). */
export const bizNoDigits = (raw: string): string => raw.replace(/[-\s]/g, '');

/** 등록·편집 공통 검사. 통과하면 저장할 값(정규화된 값)을 돌려준다. */
export function validateCompany(i: CompanyInput): CompanyCheck {
  const errors: FieldError[] = [];
  for (const k of COMPANY_FIELDS) if (i[k].length > FIELD_MAX[k]) errors.push({ field: k, code: 'too_long' });
  const long = new Set(errors.map((e) => e.field));
  const bad = (field: CompanyField, code: FieldError['code']) => { if (!long.has(field)) errors.push({ field, code }); };

  if (!i.name_ko) bad('name_ko', 'required');
  const entity = isOneOf(ENTITY_TYPES, i.entity_type) ? i.entity_type : null;
  if (!i.entity_type) bad('entity_type', 'required');
  else if (!entity) bad('entity_type', 'invalid');

  // 사업자등록번호는 한국 법인·사업자만 받는다. 중국 본사는 저장하지 않는다.
  let bizNo: string | null = null;
  if (entity === 'kr_entity') {
    const d = bizNoDigits(i.biz_no);
    if (!d) bad('biz_no', 'required');
    else if (!isValidBizNo(d)) bad('biz_no', 'invalid');
    else bizNo = d;
  }

  const stage = i.entry_stage === '' ? null : isOneOf(ENTRY_STAGES, i.entry_stage) ? i.entry_stage : undefined;
  if (stage === undefined) bad('entry_stage', 'invalid');
  if (i.website && !isHttpUrl(i.website)) bad('website', 'invalid');

  if (errors.length || !entity || stage === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name_ko: i.name_ko,
      name_zh: orNull(i.name_zh),
      entity_type: entity,
      biz_no: bizNo,
      hq_name: orNull(i.hq_name),
      entry_stage: stage,
      industry: orNull(i.industry),
      website: orNull(i.website),
      profile_ko: orNull(i.profile_ko),
    },
  };
}

/** 이 상태에서 바꿀 수 없는 항목. 검증된 기업은 신원 항목이 잠긴다. */
export function lockedFields(status: VerifyStatus): readonly CompanyField[] {
  return status === 'verified' ? IDENTITY_FIELDS : [];
}

export type EditPlan =
  | {
      ok: true;
      value: CompanyFields;
      locked: boolean;            // 신원 항목이 잠겨 있다 (value 의 신원 항목 = 현재 값)
      identityChanged: boolean;
      entityChanged: boolean;
      nextStatus: VerifyStatus;   // 반려된 기업이 신원 항목을 고치면 다시 검증 대기
      clearRejectReason: boolean;
    }
  | { ok: false; errors: FieldError[] };

/**
 * 편집 요청을 어떻게 반영할지 정한다.
 * - 검증 전(pending·rejected): 모든 항목을 고칠 수 있다
 * - 검증 후(verified): 신원 항목(name_ko·name_zh·biz_no·entity_type)은 폼 값을 버리고 현재 값을 쓴다
 * - 반려된 기업이 신원 항목을 고치면 pending 으로 되돌리고 반려 사유를 지운다
 */
export function planCompanyEdit(current: CompanyFields & { verify_status: VerifyStatus }, input: CompanyInput): EditPlan {
  const locked = lockedFields(current.verify_status);
  const merged: CompanyInput = { ...input };
  const cur = inputFromFields(current);
  for (const k of locked) merged[k] = cur[k];
  const r = validateCompany(merged);
  if (!r.ok) return r;
  const identityChanged = IDENTITY_FIELDS.some((k) => r.value[k] !== current[k]);
  const reset = current.verify_status === 'rejected' && identityChanged;
  return {
    ok: true,
    value: r.value,
    locked: locked.length > 0,
    identityChanged,
    entityChanged: r.value.entity_type !== current.entity_type,
    nextStatus: reset ? 'pending' : current.verify_status,
    clearRejectReason: reset,
  };
}

/** 서류를 새로 올린 뒤의 검증 상태: 반려된 기업은 다시 검증 대기로. */
export function statusAfterDocUpload(status: VerifyStatus): VerifyStatus {
  return status === 'rejected' ? 'pending' : status;
}

/** 등록할 때 대표 담당자의 본사 소속 여부: 중국 본사로 등록하면 본사 소속. */
export const ownerIsHq = (entity: EntityType): 0 | 1 => (entity === 'cn_hq' ? 1 : 0);

/** 초대받는 담당자의 본사 소속 여부. 한국 법인이 없는 중국 본사 기업은 항상 본사 소속이다. */
export const inviteIsHq = (entity: EntityType, checked: boolean): 0 | 1 => (entity === 'cn_hq' || checked ? 1 : 0);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteInput = { ok: true; email: string; checkedHq: boolean } | { ok: false; why: 'email_invalid' };

export function parseInvite(f: Record<string, unknown>): InviteInput {
  const email = str(f, 'email').toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, why: 'email_invalid' };
  const v = f.is_hq;
  return { ok: true, email, checkedHq: v === '1' || v === 'on' };
}

/** 담당자 + 대기 중 초대가 한도 안인가. */
export const hasSeatLeft = (members: number, pendingInvites: number): boolean => members + pendingInvites < MAX_COMPANY_SEATS;

export type RemoveCheck = 'ok' | 'self' | 'owner' | 'not_member';

/** 담당자를 내보낼 수 있는가 (권한은 authz.canManageMembers 가 먼저 본다). 자기 자신·대표 담당자는 내보낼 수 없다. */
export function removeCheck(callerId: string, target: { user_id: string; member_role: 'owner' | 'member' } | null): RemoveCheck {
  if (!target) return 'not_member';
  if (target.user_id === callerId) return 'self';
  if (target.member_role === 'owner') return 'owner';
  return 'ok';
}

export type VerifyAction =
  | { ok: true; action: 'approve' }
  | { ok: true; action: 'reject'; reason: string }
  | { ok: false; why: 'bad_action' | 'reason_required' | 'reason_too_long' };

export function parseVerifyAction(f: Record<string, unknown>): VerifyAction {
  const action = str(f, 'action');
  if (action === 'approve') return { ok: true, action };
  if (action !== 'reject') return { ok: false, why: 'bad_action' };
  const reason = str(f, 'reason').replace(/\r\n?/g, '\n');
  if (!reason) return { ok: false, why: 'reason_required' };
  if (reason.length > REJECT_REASON_MAX) return { ok: false, why: 'reason_too_long' };
  return { ok: true, action, reason };
}

/**
 * 관리자가 화면에서 본 신원 항목. 승인 폼에 숨겨 보내고, 승인할 때 현재 값과 다르면 거부한다
 * (관리자가 화면을 연 뒤 기업이 이름·번호를 바꾼 경우 확인하지 않은 값이 승인되지 않게).
 */
export function identitySnapshot(c: Pick<CompanyFields, 'name_ko' | 'name_zh' | 'biz_no' | 'entity_type'>): string {
  return JSON.stringify([c.name_ko, c.name_zh, c.biz_no, c.entity_type]);
}

/** 화면 표시용: 1248100998 → 124-81-00998 */
export function fmtBizNo(d: string | null): string {
  if (!d) return '';
  return /^\d{10}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d;
}

/** 화면 표시용 날짜 (한국 시간, YYYY-MM-DD). */
export function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return '';
  return new Date((ts + 9 * 3600) * 1000).toISOString().slice(0, 10);
}
