// Anthropic Claude (Messages API). 키는 ANTHROPIC_API_KEY.
// 문서: https://platform.claude.com/docs/en/api/http/messages/create · https://platform.claude.com/docs/en/api/overview
import { EngineError, type LocalizeEngine } from '../types';
import { isObj, postJson } from './http';

/** 2026-11 기준 가장 빠르고 저렴한 현행 모델. LOCALIZE_CLAUDE_MODEL 로 바꿀 수 있다 (예: claude-sonnet-5-5). */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';

/** 응답의 content 배열에서 type = "text" 블록만 잇는다 (thinking 블록 등은 버린다). */
export function claudeText(json: unknown): string | null {
  if (!isObj(json) || !Array.isArray(json.content)) return null;
  const parts = json.content.filter((b): b is Record<string, unknown> => isObj(b) && b.type === 'text' && typeof b.text === 'string');
  return parts.length ? parts.map((b) => b.text as string).join('') : null;
}

export const claude: LocalizeEngine = {
  id: 'claude',
  available: (env) => !!env.ANTHROPIC_API_KEY?.trim(),
  async complete(env, req, signal) {
    const json = await postJson('https://api.anthropic.com/v1/messages', {
      'x-api-key': env.ANTHROPIC_API_KEY!.trim(),
      'anthropic-version': '2023-06-01',
    }, {
      model: env.LOCALIZE_CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }, signal);
    const text = claudeText(json);
    if (text === null) throw new EngineError('bad_response');
    return text;
  },
};
