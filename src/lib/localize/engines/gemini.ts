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

export const gemini: LocalizeEngine = {
  id: 'gemini',
  available: (env) => !!env.GEMINI_API_KEY?.trim(),
  async complete(env, req, signal) {
    const model = env.LOCALIZE_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const json = await postJson(url, { 'x-goog-api-key': env.GEMINI_API_KEY!.trim() }, {
      system_instruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        // Gemini 3 계열은 기본으로 "생각" 을 한다. 번역에는 깊은 추론이 필요 없어 낮춘다 (시간 제한 25초 안에 끝나게).
        // 2.5 계열 모델로 바꾸면 thinkingLevel 을 받지 않으므로 이 줄을 지운다.
        thinkingConfig: { thinkingLevel: 'low' },
      },
    }, signal);
    const text = geminiText(json);
    if (text === null) throw new EngineError('bad_response');
    return text;
  },
};
