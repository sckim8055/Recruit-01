// 프롬프트 만들기와 엔진 출력 해석. 순수 함수 — test/localize.test.ts 로 검증한다.
// 두 번 호출한다: ① 중국어 → 한국어 현지화 초안, ② 그 한국어 초안 → 중국어 대조본.
// 대조본을 따로 만드는 이유: 같은 호출에서 만들게 하면 모델이 원문을 그대로 베낄 수 있어, 기업이 "실제로 게재될 한국어"를 확인하는 용도가 약해진다.
import { JOB_LIMITS } from '../jobs';
import type { CompleteRequest, LocalizeInput } from './types';

/** 엔진 출력 최대 길이(문자). 이보다 길면 잘못된 출력으로 본다. */
export const MAX_RAW_OUTPUT = 40_000;
/** 출력 토큰 한도. 본문 8,000자를 한 번에 옮길 수 있는 정도. */
export const MAX_OUTPUT_TOKENS = 8192;

// 금지 표현은 rules.ts 의 BANNED_PHRASES 와 같은 뜻이다. 엔진 출력에 들어가더라도 게재 단계에서 publishBlocks 가 막는다.
export const LOCALIZE_SYSTEM = [
  '당신은 한국에 진출한 중국 기업의 채용 공고를 한국 구직자가 읽기 쉬운 한국어 채용 공고로 옮기는 편집자입니다.',
  '규칙:',
  '1. 한국 채용 공고의 관례(담당업무·자격요건·우대사항·근무조건 같은 구성, 자연스러운 존댓말 문체)에 맞게 다듬되 원문의 뜻을 바꾸지 마세요.',
  '2. 원문에 없는 복리후생·근무조건·자격요건·혜택을 더하지 마세요. 원문에 있는 내용을 빼지 마세요.',
  '3. 숫자(금액·연차·인원·시간·날짜·비율)는 원문의 값을 그대로 쓰세요. 단위를 환산하거나 숫자를 새로 만들지 마세요.',
  '4. "취업상담", "취업추천", "취업지원", "취업알선" 이라는 표현을 쓰지 마세요.',
  '5. 연락처·이메일·전화번호를 만들어 넣지 마세요.',
  '6. 출력은 JSON 객체 하나만 내세요. 설명·머리말·코드 블록 표시를 붙이지 마세요.',
  '형식: {"title_ko": "한 줄 제목", "body_ko": "본문 (줄바꿈은 \\n)"}',
  `제목은 ${JOB_LIMITS.title}자, 본문은 ${JOB_LIMITS.body}자를 넘지 마세요.`,
].join('\n');

export const BACK_SYSTEM = [
  '당신은 번역가입니다. 주어진 한국어 채용 공고를 중국어(简体中文)로 충실하게 번역하세요.',
  '중국 기업 담당자가 "한국어로 무엇이 게재되는지" 확인하는 용도이므로, 다듬거나 보충하지 말고 한국어에 적힌 내용만 그대로 옮기세요.',
  '숫자는 그대로 쓰세요. 출력은 JSON 객체 하나만 내세요. 설명·코드 블록 표시를 붙이지 마세요.',
  '형식: {"title_zh": "제목", "body_zh": "본문 (줄바꿈은 \\n)"}',
].join('\n');

export function localizeRequest(i: LocalizeInput): CompleteRequest {
  return {
    system: LOCALIZE_SYSTEM,
    user: `아래 중국어 채용 공고를 규칙에 따라 한국어 채용 공고로 옮겨 주세요.\n\n[제목]\n${i.titleZh}\n\n[본문]\n${i.bodyZh}`,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

export function backRequest(ko: { title_ko: string; body_ko: string }): CompleteRequest {
  return {
    system: BACK_SYSTEM,
    user: `[제목]\n${ko.title_ko}\n\n[본문]\n${ko.body_ko}`,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

export type ParseFail = 'empty' | 'oversized' | 'not_json' | 'missing_field' | 'too_long';
export type Parsed<K extends string> = { ok: true; value: Record<K, string> } | { ok: false; why: ParseFail };

/**
 * 엔진 출력에서 JSON 객체를 꺼낸다. 모델이 지시를 어기는 경우를 감안해 방어적으로 읽는다:
 * <think>…</think> 같은 추론 표시를 버리고, 코드 블록(```json) 안 또는 첫 "{" 부터 마지막 "}" 까지를 JSON 으로 읽는다.
 * 지정한 필드가 모두 비어 있지 않은 문자열이어야 하고, 길이 한도를 넘으면 거부한다.
 */
export function parseJsonOutput<K extends string>(raw: string, fields: Record<K, number>): Parsed<K> {
  if (!raw || !raw.trim()) return { ok: false, why: 'empty' };
  if (raw.length > MAX_RAW_OUTPUT) return { ok: false, why: 'oversized' };
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, why: 'not_json' };
  let obj: unknown;
  try {
    obj = JSON.parse(s.slice(a, b + 1));
  } catch {
    return { ok: false, why: 'not_json' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, why: 'not_json' };
  const out = {} as Record<K, string>;
  for (const k of Object.keys(fields) as K[]) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !v.trim()) return { ok: false, why: 'missing_field' };
    const clean = v.replace(/\r\n?/g, '\n').trim();
    if (clean.length > fields[k]) return { ok: false, why: 'too_long' };
    out[k] = clean;
  }
  return { ok: true, value: out };
}

/** 제목은 한 줄로. */
export const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

export const parseLocalized = (raw: string) => {
  const r = parseJsonOutput(raw, { title_ko: JOB_LIMITS.title, body_ko: JOB_LIMITS.body });
  return r.ok ? { ok: true as const, title_ko: oneLine(r.value.title_ko), body_ko: r.value.body_ko } : r;
};

export const parseBack = (raw: string) => {
  // 대조본은 화면 확인용이라 한도를 조금 넉넉히 둔다.
  const r = parseJsonOutput(raw, { title_zh: JOB_LIMITS.title * 2, body_zh: JOB_LIMITS.body * 2 });
  return r.ok ? { ok: true as const, back_zh: `${oneLine(r.value.title_zh)}\n\n${r.value.body_zh}` } : r;
};
