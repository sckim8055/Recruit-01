// Cloudflare Workers AI (AI 바인딩). 키가 필요 없고 Cloudflare 계정 안에서 실행된다.
// 사용 예: env.AI.run(model, { messages }) — https://developers.cloudflare.com/ai/models/@cf/zai-org/glm-4.7-flash/
// 모델은 LOCALIZE_WORKERS_AI_MODEL 로 바꿀 수 있다 (운영자가 Cloudflare 대시보드의 Workers AI 모델 목록에서 고른다).
// 출력 모양이 모델마다 다르다 ({ response } 또는 choices[0].message.content). 둘 다 읽는다.
import { EngineError, type LocalizeEngine } from '../types';
import { chatText } from './http';

/** 2026-05 에 이전 Llama 3.x 모델이 지원 종료되며 Cloudflare 가 권장한 대체 모델 중 하나. 중국어·한국어를 포함한 다국어 모델. */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/zai-org/glm-4.7-flash';

export const workersAi: LocalizeEngine = {
  id: 'workers_ai',
  available: (env) => !!env.AI && typeof env.AI.run === 'function',
  async complete(env, req, signal) {
    if (!env.AI) throw new EngineError('network');
    const model = env.LOCALIZE_WORKERS_AI_MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL;
    // AI.run 은 AbortSignal 을 받지 않으므로 시간 제한은 경쟁(race)으로 건다.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new EngineError('timeout'));
      signal.addEventListener('abort', () => reject(new EngineError('timeout')), { once: true });
    });
    let out: unknown;
    try {
      out = await Promise.race([
        env.AI.run(model, {
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
          // max_tokens 는 Llama 계열의 이름이고, GLM 은 max_completion_tokens 를 권하지만 max_tokens 도 받는다 (문서상 deprecated).
          max_tokens: req.maxTokens,
        }),
        aborted,
      ]);
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new EngineError('network');
    }
    const text = chatText(out);
    if (text === null) throw new EngineError('bad_response');
    return text;
  },
};
