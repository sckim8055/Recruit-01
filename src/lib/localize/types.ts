// 현지화 엔진 공통 타입. 엔진은 설정(LOCALIZE_ENGINE·키·모델 변수)으로 바꾸고, 코드는 고치지 않는다.
// 엔진에 보내는 것은 공고 제목·본문(기업이 쓴 글)뿐이다. 연락처·이름 같은 항목은 프롬프트에 넣지 않는다.

/** 엔진이 읽는 환경값. Env 의 일부만 쓴다 (테스트에서 가짜 환경을 넘기기 쉽게). */
export interface LocalizeEnv {
  LOCALIZE_ENGINE?: string;
  LOCALIZE_GEMINI_MODEL?: string;
  LOCALIZE_CLAUDE_MODEL?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface CompleteRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LocalizeEngine {
  /** 설정값(LOCALIZE_ENGINE)·DB(jobs.localize_engine)에 쓰는 id. 기업 화면에는 보여주지 않는다. */
  id: string;
  /** 키·바인딩이 있어 쓸 수 있는가. */
  available(env: LocalizeEnv): boolean;
  /** 한 번 호출해 모델이 낸 글을 그대로 돌려준다. 실패하면 EngineError 를 던진다. 재시도하지 않는다. */
  complete(env: LocalizeEnv, req: CompleteRequest, signal: AbortSignal): Promise<string>;
}

/** 엔진 호출 실패. status 는 HTTP 상태(있으면). 메시지에 요청·응답 본문이나 키를 넣지 않는다. */
export class EngineError extends Error {
  /**
   * detail: 제공자가 돌려준 오류 설명(예: "model not found"). 진단용이며 **개발 환경(APP_ENV=dev)에서만** 콘솔에 찍는다
   * (lib/localize/index.ts). 화면·메시지에는 넣지 않는다. 운영·테스트 환경에서는 버린다.
   */
  constructor(readonly code: 'http' | 'timeout' | 'bad_response' | 'network', readonly status?: number, readonly detail?: string) {
    super(status ? `${code}_${status}` : code);
  }
}

export interface LocalizeInput {
  titleZh: string;
  bodyZh: string;
}

export interface LocalizeDraft {
  engine: string;
  title_ko: string;
  body_ko: string;
  back_zh: string;
}

export type LocalizeOutcome =
  | ({ ok: true } & LocalizeDraft)
  /** no_engine: 쓸 수 있는 엔진이 없다(수동 입력). all_failed: 모두 실패했다. tried 는 시도한 엔진 id (콘솔·관리자용). */
  | { ok: false; why: 'no_engine' | 'all_failed'; tried: string[] };

export type EngineRun =
  | { ok: true; title_ko: string; body_ko: string; back_zh: string; ms: number }
  | { ok: false; error: string; ms: number };
