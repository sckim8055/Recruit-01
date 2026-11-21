// Google Gemini API (REST generateContent). 키는 GEMINI_API_KEY, 주소가 아니라 x-goog-api-key 헤더로 보낸다.
// 문서: https://ai.google.dev/gemini-api/docs/generate-content/text-generation
import { EngineError, type LocalizeEngine } from '../types';
import { isObj, postJson } from './http';

/** 2026-11 기준 문서에 Stable 로 표시된 Flash 모델. LOCALIZE_GEMINI_MODEL 로 바꿀 수 있다. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** 응답의 candidates[0].content.parts 에서 사고(thought) 부분을 빼고 글을 잇는다. */
export function geminiText(json: unknown): string | null {
  if (!isObj(json) || !Array.isArray(json.candidates) || !isObj(json.candidates[0])) return null;
  const content = json.candidates[0].content;
  if (!isObj(content) || !Array.isArray(content.parts)) return null;
  const parts = content.parts.filter((p): p is Record<string, unknown> => isObj(p) && p.thought !== true && typeof p.text === 'string');
  return parts.length ? parts.map((p) => p.text as string).join('') : null;
}

/**
 * 기본 모델이 혼잡하거나(503 "high demand") 한도에 걸리거나(429) 응답이 늦을 때 차례로 써 볼 모델.
 * LOCALIZE_GEMINI_MODEL 에 쉼표로 여러 개를 적으면 그 순서를 쓴다 (예: "gemini-3.8-flash,gemini-3.5-flash").
 * 모델 이름은 `node scripts/test-gemini.mjs` 의 목록에서 확인한다.
 */
export const GEMINI_FALLBACK_MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash'] as const;
/** 모델 하나에 기다리는 시간. 전체 제한(lib/localize/index.ts ENGINE_TIMEOUT_MS = 25초) 안에서 두 번은 시도할 수 있게 한다. */
export const GEMINI_ATTEMPT_MS = 11_000;

export function geminiModels(raw: string | undefined): string[] {
  const list = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return [...new Set(list.length ? list : [DEFAULT_GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS])];
}

/** 다음 모델로 넘어가도 되는 실패인가: 혼잡·한도·서버 오류·모델 없음·시간 초과·연결 실패. 키 오류(401·403)나 요청 오류(400)는 아니다. */
export function geminiRetryable(e: EngineError): boolean {
  if (e.code === 'timeout' || e.code === 'network') return true;
  return e.code === 'http' && (e.status === 404 || e.status === 429 || (e.status ?? 0) >= 500);
}

async function callModel(env: { GEMINI_API_KEY?: string }, model: string, req: { system: string; user: string; maxTokens: number }, outer: AbortSignal): Promise<string> {
  // 이 모델 몫의 제한 시간. 바깥 제한(outer)이 먼저 끝나면 같이 끝난다.
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  outer.addEventListener('abort', onOuter);
  const timer = setTimeout(() => ac.abort(), GEMINI_ATTEMPT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const json = await postJson(url, { 'x-goog-api-key': env.GEMINI_API_KEY!.trim() }, {
      system_instruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        // Gemini 3 계열은 기본으로 "생각" 을 한다. 번역에는 깊은 추론이 필요 없어 낮춘다.
        // 2.5 계열 모델은 thinkingLevel 을 받지 않는다 (400) — 그 계열을 쓰려면 이 줄을 지운다.
        thinkingConfig: { thinkingLevel: 'low' },
      },
    }, ac.signal);
    const text = geminiText(json);
    if (text === null) throw new EngineError('bad_response');
    return text;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
}

export const gemini: LocalizeEngine = {
  id: 'gemini',
  available: (env) => !!env.GEMINI_API_KEY?.trim(),
  async complete(env, req, signal) {
    let last: EngineError = new EngineError('network');
    for (const model of geminiModels(env.LOCALIZE_GEMINI_MODEL)) {
      if (signal.aborted) break;
      try {
        return await callModel(env, model, req, signal);
      } catch (e) {
        last = e instanceof EngineError ? e : new EngineError('network');
        if (!geminiRetryable(last)) throw last;
      }
    }
    throw last;
  },
};
