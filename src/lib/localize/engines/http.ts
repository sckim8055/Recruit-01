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
    // 오류 본문에서 제공자의 오류 설명만 짧게 꺼낸다 (진단용, 개발 환경에서만 찍힌다 — EngineError.detail).
    throw new EngineError('http', res.status, await errorDetail(res));
  }
  try {
    return await res.json();
  } catch {
    throw new EngineError(signal.aborted ? 'timeout' : 'bad_response');
  }
}

/** 오류 응답에서 설명 문장만 뽑는다: {error:{message,status}} (Google·Anthropic·OpenAI 공통 모양) 또는 {errors:[{message}]} (Cloudflare). 300자까지. */
export async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 4000);
    let msg = '';
    try {
      const j: unknown = JSON.parse(text);
      if (isObj(j)) {
        const e = j.error;
        if (isObj(e)) msg = [e.status, e.type, e.code, e.message].filter((x) => typeof x === 'string' || typeof x === 'number').join(' ');
        else if (typeof e === 'string') msg = e;
        else if (Array.isArray(j.errors) && isObj(j.errors[0]) && typeof j.errors[0].message === 'string') msg = j.errors[0].message;
      }
    } catch { /* JSON 이 아니면 설명 없이 */ }
    return msg ? msg.replace(/\s+/g, ' ').slice(0, 300) : undefined;
  } catch {
    return undefined;
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
