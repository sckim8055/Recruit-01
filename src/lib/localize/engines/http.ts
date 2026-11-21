// 엔진 어댑터 공통: fetch 한 번 호출, 응답 JSON 읽기. 요청·응답 본문과 키는 로그에 남기지 않는다.
import { EngineError } from '../types';

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch {
    throw new EngineError(signal.aborted ? 'timeout' : 'network');
  }
  if (!res.ok) {
    // 오류 본문은 읽어서 버린다 (연결 정리). 내용은 남기지 않는다.
    await res.body?.cancel().catch(() => {});
    throw new EngineError('http', res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new EngineError(signal.aborted ? 'timeout' : 'bad_response');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * OpenAI Chat Completions 모양(choices[0].message.content)이나 Workers AI 의 { response } 모양에서 글을 꺼낸다.
 * 둘 다 아니면 null.
 */
export function chatText(json: unknown): string | null {
  if (!isObj(json)) return null;
  if (typeof json.response === 'string') return json.response;
  const choices = json.choices;
  if (Array.isArray(choices) && isObj(choices[0])) {
    const msg = choices[0].message;
    if (isObj(msg) && typeof msg.content === 'string') return msg.content;
    if (typeof choices[0].text === 'string') return choices[0].text;
  }
  return null;
}

export { isObj };
