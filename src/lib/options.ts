// 직무·업계·근무지 선택 항목 (T-06e). 순수 함수만 둔다 (DB·네트워크 접근 없음) — test/options.test.ts 로 검증한다.
//
// 항목은 DB(job_options, 0007)에만 있다. 관리자가 /admin/options 에서 추가하고 이름·순서를 바꾸고 사용 종료·다시 사용을 한다. 삭제는 없다.
// - 공고에 저장된 값은 code 다. code 는 한 번 만들면 바꾸지 않는다 (kind 도).
// - 사용 종료(active = 0)된 항목은 새 공고 작성 폼과 공개 검색 칸에서만 빠진다. 그 값을 가진 공고는 이름이 예전처럼 보인다 (labelOf).
// - 기존 공고를 고칠 때는 지금 저장된 값이 사용 종료여도 그대로 고를 수 있다 (selectableCodes) — 다른 칸을 고치려고 분류를 바꾸게 하지 않는다.
// 관리자가 입력한 이름은 믿을 수 없는 글로 본다. 화면에는 JSX 로만 출력한다 (자동 이스케이프).
import type { Locale } from '../env';
import { findBannedPhrases } from './rules';

export const OPTION_KINDS = ['role_category', 'industry', 'location'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];
export const isOptionKind = (v: unknown): v is OptionKind => typeof v === 'string' && (OPTION_KINDS as readonly string[]).includes(v);

/** job_options 한 행 (화면·판단에 쓰는 컬럼만). active 는 0/1. */
export interface OptionRow {
  kind: OptionKind;
  code: string;
  label_ko: string;
  label_zh: string;
  sort: number;
  active: number;
}

/** 종류별로 순서(sort, 같으면 code)대로 정렬한 항목과, code → 행 찾기. */
export interface OptionSet {
  list: Record<OptionKind, OptionRow[]>;
  byCode: Record<OptionKind, Map<string, OptionRow>>;
}

const bySort = (a: OptionRow, b: OptionRow): number => a.sort - b.sort || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** DB 행 → OptionSet. 모르는 종류의 행은 버린다 (CHECK 제약이 있어 생기지 않는다). */
export function buildOptionSet(rows: readonly OptionRow[]): OptionSet {
  const list = { role_category: [], industry: [], location: [] } as Record<OptionKind, OptionRow[]>;
  for (const r of rows) if (isOptionKind(r.kind)) list[r.kind].push({ ...r, active: r.active ? 1 : 0 });
  const byCode = {} as Record<OptionKind, Map<string, OptionRow>>;
  for (const k of OPTION_KINDS) {
    list[k].sort(bySort);
    byCode[k] = new Map(list[k].map((r) => [r.code, r]));
  }
  return { list, byCode };
}

export const findOption = (set: OptionSet, kind: OptionKind, code: string): OptionRow | undefined => set.byCode[kind].get(code);

/**
 * 공고에 저장된 code 의 이름. 사용 종료된 항목도 이름을 돌려준다 (기존 공고는 예전처럼 보인다).
 * 값이 없으면 빈 문자열, 표에 없는 code(생기면 안 된다)는 code 를 그대로 돌려준다.
 */
export function labelOf(set: OptionSet, kind: OptionKind, code: string | null | undefined, locale: Locale): string {
  if (!code) return '';
  const r = findOption(set, kind, code);
  if (!r) return code;
  return locale === 'zh' ? r.label_zh : r.label_ko;
}

/** 사용 중인 항목의 code (순서대로). 새 공고 작성 폼·공개 검색 칸이 쓴다. */
export const activeCodes = (set: OptionSet, kind: OptionKind): string[] => set.list[kind].filter((r) => r.active).map((r) => r.code);

export const isActiveCode = (set: OptionSet, kind: OptionKind, code: string): boolean => !!findOption(set, kind, code)?.active;

/**
 * 공고 작성·편집 폼에서 고를 수 있는 code = 사용 중인 항목(순서대로) + 지금 저장된 값(사용 종료이거나 표에 없을 때 맨 뒤에).
 * 새 공고는 currentCode 가 없으므로 사용 중인 항목만. 서버 검사(validateJob)도 이 목록을 그대로 받는다 (화면과 검사가 같은 목록).
 */
export function selectableCodes(set: OptionSet, kind: OptionKind, currentCode: string | null | undefined): string[] {
  const codes = activeCodes(set, kind);
  if (currentCode && !codes.includes(currentCode)) codes.push(currentCode);
  return codes;
}

/** 세 종류 모두의 selectableCodes. current 는 편집하는 공고의 저장된 값 (새 공고는 생략). */
export function selectableAll(
  set: OptionSet, current?: Partial<Record<OptionKind, string | null>>,
): Record<OptionKind, string[]> {
  return {
    role_category: selectableCodes(set, 'role_category', current?.role_category),
    industry: selectableCodes(set, 'industry', current?.industry),
    location: selectableCodes(set, 'location', current?.location),
  };
}

// ── 관리자 입력 검사

export const OPTION_LIMITS = { label: 40, sortMax: 9999 } as const;
export const OPTION_CODE_RE = /^[a-z][a-z0-9_]{1,29}$/;

export type OptionField = 'code' | 'label_ko' | 'label_zh' | 'sort';
export interface OptionFieldError {
  field: OptionField;
  code: 'required' | 'invalid' | 'too_long' | 'duplicate' | 'range' | 'banned';
}

export interface OptionLabels { label_ko: string; label_zh: string; sort: number }
export type OptionEditCheck = { ok: true; value: OptionLabels } | { ok: false; errors: OptionFieldError[] };
export type OptionAddCheck = { ok: true; value: OptionLabels & { code: string } } | { ok: false; errors: OptionFieldError[] };

/** 폼 값 (문자열만, 앞뒤 공백 제거). 파일 등은 빈 값으로 본다. */
const str = (f: Record<string, unknown>, k: string): string => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');

/** 폼에 다시 채울 값 (오류가 났을 때). */
export interface OptionInput { code: string; label_ko: string; label_zh: string; sort: string }
export const readOptionInput = (f: Record<string, unknown>): OptionInput =>
  ({ code: str(f, 'code'), label_ko: str(f, 'label_ko'), label_zh: str(f, 'label_zh'), sort: str(f, 'sort') });

// 줄바꿈·제어 문자는 받지 않는다 (한 줄 이름).
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

function checkLabels(i: OptionInput, errors: OptionFieldError[]): OptionLabels | null {
  const label = (field: 'label_ko' | 'label_zh'): string | null => {
    const v = i[field];
    if (!v) { errors.push({ field, code: 'required' }); return null; }
    if (CONTROL_RE.test(v)) { errors.push({ field, code: 'invalid' }); return null; }
    if ([...v].length > OPTION_LIMITS.label) { errors.push({ field, code: 'too_long' }); return null; }
    // 화면 문구와 같은 금지 표현 검사 (CLAUDE.md 규칙 8). 공개 화면에 그대로 나오므로.
    if (findBannedPhrases(v).length) { errors.push({ field, code: 'banned' }); return null; }
    return v;
  };
  const label_ko = label('label_ko');
  const label_zh = label('label_zh');
  let sort: number | null = null;
  if (!i.sort) errors.push({ field: 'sort', code: 'required' });
  else if (!/^\d{1,4}$/.test(i.sort)) errors.push({ field: 'sort', code: /^\d+$/.test(i.sort) ? 'range' : 'invalid' });
  else sort = Number(i.sort);
  return label_ko != null && label_zh != null && sort != null ? { label_ko, label_zh, sort } : null;
}

/** 이름·순서 고치기. code·kind 는 받지 않는다 (바꿀 수 없다). */
export function validateOptionEdit(i: OptionInput): OptionEditCheck {
  const errors: OptionFieldError[] = [];
  const v = checkLabels(i, errors);
  return v && !errors.length ? { ok: true, value: v } : { ok: false, errors };
}

/** 새 항목. code 는 소문자로 시작하는 영문 소문자·숫자·밑줄 2~30자, 같은 종류 안에서 겹치면 안 된다 (사용 종료된 항목 포함). */
export function validateOptionAdd(i: OptionInput, set: OptionSet, kind: OptionKind): OptionAddCheck {
  const errors: OptionFieldError[] = [];
  let code: string | null = null;
  if (!i.code) errors.push({ field: 'code', code: 'required' });
  else if (!OPTION_CODE_RE.test(i.code)) errors.push({ field: 'code', code: 'invalid' });
  else if (findOption(set, kind, i.code)) errors.push({ field: 'code', code: 'duplicate' });
  else code = i.code;
  const v = checkLabels(i, errors);
  return v && code && !errors.length ? { ok: true, value: { ...v, code } } : { ok: false, errors };
}

/** 새 항목 폼에 미리 채울 순서: 지금 가장 큰 값 + 10 (최대 9999). */
export const nextSort = (set: OptionSet, kind: OptionKind): number =>
  Math.min(OPTION_LIMITS.sortMax, set.list[kind].reduce((m, r) => Math.max(m, r.sort), 0) + 10);

/**
 * 사용 종료 전 확인. 종류마다 사용 중인 항목이 하나는 남아야 한다 (DB 의 UPDATE 도 같은 조건으로 한 번 더 막는다 — db/options.setOptionActive).
 * 공고 폼의 직무·업계·근무지는 선택 사항이라 목록이 비어도 저장은 되지만, 고를 것이 없는 칸은 쓸모가 없으므로 막는다.
 */
export function retireProblem(set: OptionSet, kind: OptionKind, code: string): 'unknown' | 'already_inactive' | 'last_active' | null {
  const r = findOption(set, kind, code);
  if (!r) return 'unknown';
  if (!r.active) return 'already_inactive';
  if (activeCodes(set, kind).length <= 1) return 'last_active';
  return null;
}

export function restoreProblem(set: OptionSet, kind: OptionKind, code: string): 'unknown' | 'already_active' | null {
  const r = findOption(set, kind, code);
  if (!r) return 'unknown';
  return r.active ? 'already_active' : null;
}
