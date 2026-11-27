// OpenAI Chat Completions 호환 API 용 엔진 만들기 (OpenAI·Kimi·DeepSeek·CLOVA 등). 지금은 쓰는 엔진이 없다.
//
// 새 엔진 추가 방법 (파일 하나):
//   1) src/lib/localize/engines/<이름>.ts 를 만들고 아래처럼 적는다.
//        export const deepseek = openAiCompatEngine({
//          id: 'deepseek', keyVar: 'DEEPSEEK_API_KEY', modelVar: 'LOCALIZE_DEEPSEEK_MODEL',
//          defaultModel: '<문서에서 확인한 모델 id>', baseUrl: 'https://<서비스 주소>/v1',
//        });
//   2) registry.ts 의 ENGINES 배열에 넣는다 (순서 = 기본 시도 순서).
//   3) 운영자가 키를 서버 PC 의 .env 에 <keyVar>=… 로 넣고(src/env.ts·src/server-env.ts 의 이름 목록에도 더한다) 서버를 다시 시작한다. 선택 사항: LOCALIZE_ENGINE=<id>.
//   서비스마다 요청 모양이 조금씩 다르므로 붙이기 전에 그 서비스의 공식 문서로 주소·모델 id 를 확인한다.
import { EngineError, type LocalizeEngine, type LocalizeEnv } from '../types';
import { chatText, postJson } from './http';

export interface OpenAiCompatConfig {
  id: string;
  keyVar: string;
  modelVar: string;
  defaultModel: string;
  baseUrl: string;   // .../v1 까지. 뒤에 /chat/completions 를 붙인다
}

const envStr = (env: LocalizeEnv, k: string): string => {
  const v = (env as Record<string, unknown>)[k];
  return typeof v === 'string' ? v.trim() : '';
};

export function openAiCompatEngine(cfg: OpenAiCompatConfig): LocalizeEngine {
  return {
    id: cfg.id,
    available: (env) => envStr(env, cfg.keyVar) !== '',
    async complete(env, req, signal) {
      const json = await postJson(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, { authorization: `Bearer ${envStr(env, cfg.keyVar)}` }, {
        model: envStr(env, cfg.modelVar) || cfg.defaultModel,
        max_tokens: req.maxTokens,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      }, signal);
      const text = chatText(json);
      if (text === null) throw new EngineError('bad_response');
      return text;
    },
  };
}
