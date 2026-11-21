// 기업 담당자가 지원자에게 보내는 메시지(면접 요청)를 한국어로 옮긴다. T-09b.
// 엔진에는 **기업이 쓴 메시지 글만** 보낸다. 지원자의 이름·연락처·지원서 내용은 보내지 않는다 (CLAUDE.md 규칙 6).
// 번역은 참고용이다: 메일에는 원문과 번역을 함께 넣는다 (lib/applicant-mail.ts). 번역에 실패하면 원문만 보낸다.
import { availableEngines, callEngine, engineOrder, TOTAL_BUDGET_MS } from './index';
import { parseJsonOutput } from './prompt';
import { ENGINES } from './registry';
import { EngineError, type CompleteRequest, type LocalizeEngine, type LocalizeEnv } from './types';

export const MESSAGE_MAX = 2000;

export const MESSAGE_SYSTEM = [
  '당신은 번역가입니다. 중국 기업의 채용 담당자가 한국의 지원자에게 보내는 메시지를 한국어로 옮깁니다.',
  '규칙:',
  '1. 구성은 원문 그대로 두세요: 문단·줄바꿈·번호·순서를 바꾸지 말고, 문장만 자연스러운 존댓말 한국어로 옮기세요.',
  '2. 원문에 없는 내용(인사말·약속·조건·일정·설명)을 더하지 말고, 있는 내용을 빼지 마세요.',
  '3. 날짜·시간·숫자·금액·주소·전화번호·이메일·링크·사람 이름·회사 이름은 원문 그대로 쓰세요. 시간대를 환산하지 마세요.',
  '4. 번역자 메모·안내문("[참고]", "※" 등)을 넣지 마세요.',
  '5. 원문이 이미 한국어이면 그대로 돌려주세요.',
  '6. 출력은 JSON 객체 하나만 내세요. 설명·코드 블록 표시를 붙이지 마세요.',
  '형식: {"ko": "한국어 번역 (줄바꿈은 \\n)"}',
].join('\n');

export function messageRequest(text: string): CompleteRequest {
  return { system: MESSAGE_SYSTEM, user: `아래 메시지를 규칙에 따라 한국어로 옮겨 주세요.\n\n${text}`, maxTokens: 4096 };
}

/** 엔진 출력에서 번역을 꺼낸다. 번역이 원문보다 지나치게 길면(4배 + 200자) 덧붙인 것으로 보고 버린다. */
export function parseMessageTranslation(raw: string, original: string): string | null {
  const p = parseJsonOutput(raw, { ko: MESSAGE_MAX * 4 });
  if (!p.ok) return null;
  const ko = p.value.ko;
  return ko.length > original.length * 4 + 200 ? null : ko;
}

export type MessageTranslation = { ok: true; ko: string; engine: string } | { ok: false; why: 'no_engine' | 'all_failed' };

/** 쓸 수 있는 엔진을 순서대로 한 번씩 시도한다. 실패해도 예외를 던지지 않는다. */
export async function translateMessage(
  env: LocalizeEnv, text: string, engines: readonly LocalizeEngine[] = ENGINES, clock: () => number = Date.now,
): Promise<MessageTranslation> {
  const avail = availableEngines(env, engines);
  const order = engineOrder(engines.map((e) => e.id), avail.map((e) => e.id), env.LOCALIZE_ENGINE);
  if (!order.length) return { ok: false, why: 'no_engine' };
  const t0 = clock();
  let tried = 0;
  for (const id of order) {
    if (tried && clock() - t0 > TOTAL_BUDGET_MS) break;
    tried++;
    const engine = avail.find((e) => e.id === id)!;
    try {
      const ko = parseMessageTranslation(await callEngine(engine, env, messageRequest(text)), text);
      if (ko) return { ok: true, ko, engine: id };
      console.error(`message: engine=${id} failed=output`);
    } catch (e) {
      console.error(`message: engine=${id} failed=${e instanceof EngineError ? e.message : 'error'}`);
    }
  }
  return { ok: false, why: 'all_failed' };
}
