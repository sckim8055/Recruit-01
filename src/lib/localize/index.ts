// 현지화: 중국어 공고 → 한국어 초안 + 중국어 대조본. 엔진 순서·시간 제한·출력 검사는 여기서, 엔진별 호출은 engines/ 에서.
// 엔진 하나당 한 번만 시도한다(재시도 없음). 실패하면 다음 엔진, 모두 실패하거나 쓸 수 있는 엔진이 없으면 수동 입력.
// 콘솔에는 엔진 id 와 오류 종류(HTTP 상태)만 남긴다. 공고 글·키는 남기지 않는다.
// translations 캐시 테이블은 쓰지 않는다: 결과는 공고 행에 저장되고, "다시 만들기" 는 새 결과를 원하므로 캐시가 오히려 방해된다.
import { backRequest, localizeRequest, parseBack, parseLocalized } from './prompt';
import { ENGINES } from './registry';
import { EngineError, type EngineRun, type LocalizeEngine, type LocalizeEnv, type LocalizeInput, type LocalizeOutcome } from './types';

/** 엔진 호출 한 번의 시간 제한. */
export const ENGINE_TIMEOUT_MS = 25_000;
/** 이 시간이 지나면 다음 엔진을 시작하지 않는다 (요청 하나가 너무 오래 걸리지 않게). */
export const TOTAL_BUDGET_MS = 55_000;

/**
 * 시도 순서. 순수 함수.
 * - preferred(LOCALIZE_ENGINE)가 쓸 수 있으면 맨 앞, 나머지는 registry 순서
 * - after(지난번에 쓴 엔진)가 있으면 그다음 엔진부터 시작해 한 바퀴 돈다 (지난번 엔진은 맨 뒤)
 */
export function engineOrder(allIds: readonly string[], availableIds: readonly string[], preferred?: string | null, after?: string | null): string[] {
  const avail = allIds.filter((id) => availableIds.includes(id));
  const p = preferred?.trim();
  const base = p && avail.includes(p) ? [p, ...avail.filter((id) => id !== p)] : avail;
  if (!after || !base.includes(after)) return base;
  const i = base.indexOf(after);
  return [...base.slice(i + 1), ...base.slice(0, i + 1)];
}

export const availableEngines = (env: LocalizeEnv, engines: readonly LocalizeEngine[] = ENGINES): LocalizeEngine[] =>
  engines.filter((e) => {
    try {
      return e.available(env);
    } catch {
      return false;
    }
  });

export async function callEngine(engine: LocalizeEngine, env: LocalizeEnv, req: Parameters<LocalizeEngine['complete']>[1]): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ENGINE_TIMEOUT_MS);
  try {
    return await engine.complete(env, req, ac.signal);
  } catch (e) {
    throw e instanceof EngineError ? e : new EngineError(ac.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** 엔진 하나로 초안과 대조본을 만든다 (호출 두 번). 실패 사유는 짧은 코드로. */
export async function runEngine(engine: LocalizeEngine, env: LocalizeEnv, input: LocalizeInput, clock: () => number = Date.now): Promise<EngineRun> {
  const t0 = clock();
  const fail = (error: string, detail?: string): EngineRun => {
    // detail(제공자의 오류 설명)은 개발 환경에서만 찍는다. 개발 환경에는 가짜 데이터만 있다 (CLAUDE.md 규칙 10).
    const more = detail && (env as { APP_ENV?: string }).APP_ENV === 'dev' ? ` detail=${detail}` : '';
    console.error(`localize: engine=${engine.id} failed=${error}${more}`);
    return { ok: false, error, ms: clock() - t0 };
  };
  try {
    // 모델이 낸 글의 앞부분(200자)은 형식이 틀렸을 때 진단용으로만 쓴다 — fail() 이 개발 환경에서만 찍는다.
    const head = (s: string) => s.replace(/\s+/g, ' ').slice(0, 200);
    const koRaw = await callEngine(engine, env, localizeRequest(input));
    const ko = parseLocalized(koRaw);
    if (!ko.ok) return fail(`output_${ko.why}`, head(koRaw));
    const backRaw = await callEngine(engine, env, backRequest(ko));
    const back = parseBack(backRaw);
    if (!back.ok) return fail(`back_output_${back.why}`, head(backRaw));
    return { ok: true, title_ko: ko.title_ko, body_ko: ko.body_ko, back_zh: back.back_zh, ms: clock() - t0 };
  } catch (e) {
    return e instanceof EngineError ? fail(e.message, e.detail) : fail('error');
  }
}

/** 공고 현지화. opts.after: 지난번에 쓴 엔진 id ("다시 만들기"). */
export async function localizeJob(
  env: LocalizeEnv,
  input: LocalizeInput,
  opts: { after?: string | null } = {},
  engines: readonly LocalizeEngine[] = ENGINES,
  clock: () => number = Date.now,
): Promise<LocalizeOutcome> {
  const avail = availableEngines(env, engines);
  const order = engineOrder(engines.map((e) => e.id), avail.map((e) => e.id), env.LOCALIZE_ENGINE, opts.after);
  if (!order.length) return { ok: false, why: 'no_engine', tried: [] };
  const t0 = clock();
  const tried: string[] = [];
  for (const id of order) {
    if (tried.length && clock() - t0 > TOTAL_BUDGET_MS) break;
    const engine = avail.find((e) => e.id === id)!;
    tried.push(id);
    const r = await runEngine(engine, env, input, clock);
    if (r.ok) return { ok: true, engine: id, title_ko: r.title_ko, body_ko: r.body_ko, back_zh: r.back_zh };
  }
  return { ok: false, why: 'all_failed', tried };
}
