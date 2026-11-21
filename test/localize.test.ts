import { afterEach, describe, expect, it, vi } from 'vitest';
import { claude, claudeText, DEFAULT_CLAUDE_MODEL } from '../src/lib/localize/engines/claude';
import { DEFAULT_GEMINI_MODEL, gemini, geminiText } from '../src/lib/localize/engines/gemini';
import { chatText } from '../src/lib/localize/engines/http';
import { openAiCompatEngine } from '../src/lib/localize/engines/openai-compat';
import { DEFAULT_WORKERS_AI_MODEL, workersAi } from '../src/lib/localize/engines/workers-ai';
import { availableEngines, engineOrder, localizeJob, runEngine } from '../src/lib/localize';
import { BACK_SYSTEM, LOCALIZE_SYSTEM, MAX_RAW_OUTPUT, backRequest, localizeRequest, parseBack, parseJsonOutput, parseLocalized } from '../src/lib/localize/prompt';
import { ENGINES } from '../src/lib/localize/registry';
import { EngineError, type LocalizeEngine } from '../src/lib/localize/types';

const ALL = ['claude', 'gemini', 'workers_ai'];

describe('engineOrder', () => {
  it('쓸 수 있는 엔진만, registry 순서', () => expect(engineOrder(ALL, ['workers_ai', 'claude'])).toEqual(['claude', 'workers_ai']));
  it('LOCALIZE_ENGINE 이 쓸 수 있으면 맨 앞', () => expect(engineOrder(ALL, ALL, 'gemini')).toEqual(['gemini', 'claude', 'workers_ai']));
  it('LOCALIZE_ENGINE 이 쓸 수 없으면 무시', () => expect(engineOrder(ALL, ['workers_ai'], 'gemini')).toEqual(['workers_ai']));
  it('다시 만들기: 지난번 엔진 다음부터 한 바퀴', () => {
    expect(engineOrder(ALL, ALL, 'gemini', 'gemini')).toEqual(['claude', 'workers_ai', 'gemini']);
    expect(engineOrder(ALL, ALL, null, 'workers_ai')).toEqual(['claude', 'gemini', 'workers_ai']);
    expect(engineOrder(ALL, ['claude'], null, 'claude')).toEqual(['claude']);
  });
  it('지난번 엔진이 지금 쓸 수 없으면 기본 순서', () => expect(engineOrder(ALL, ['claude', 'gemini'], null, 'workers_ai')).toEqual(['claude', 'gemini']));
  it('쓸 수 있는 엔진이 없으면 빈 배열 (수동 입력)', () => expect(engineOrder(ALL, [], 'claude')).toEqual([]));
  it('registry 는 workers_ai 로 끝난다', () => expect(ENGINES.map((e) => e.id)).toEqual(ALL));
});

describe('프롬프트', () => {
  it('지시 사항: 관례, 뜻 유지, 조건 추가 금지, 숫자 그대로, 금지 표현, JSON', () => {
    for (const s of ['관례', '뜻을 바꾸지', '더하지 마세요', '숫자', '취업상담', '취업추천', '취업지원', '취업알선', 'JSON']) expect(LOCALIZE_SYSTEM).toContain(s);
    expect(BACK_SYSTEM).toContain('JSON');
  });
  it('사용자 메시지에는 제목·본문만 들어간다', () => {
    const r = localizeRequest({ titleZh: '销售经理', bodyZh: '负责销售' });
    expect(r.user).toContain('销售经理');
    expect(r.user).toContain('负责销售');
    expect(r.user).not.toMatch(/@|contact|연락처 이메일/);
    expect(backRequest({ title_ko: '영업', body_ko: '본문' }).user).toBe('[제목]\n영업\n\n[본문]\n본문');
  });
});

describe('출력 해석', () => {
  const good = JSON.stringify({ title_ko: '영업 매니저', body_ko: '담당업무\n- B2B 영업' });
  it('JSON 그대로', () => expect(parseLocalized(good)).toEqual({ ok: true, title_ko: '영업 매니저', body_ko: '담당업무\n- B2B 영업' }));
  it('코드 블록·머리말·<think> 를 버린다', () => {
    expect(parseLocalized('```json\n' + good + '\n```').ok).toBe(true);
    expect(parseLocalized('다음과 같습니다:\n' + good + '\n감사합니다').ok).toBe(true);
    expect(parseLocalized('<think>{"x": 1} 고민</think>' + good).ok).toBe(true);
  });
  it('제목의 줄바꿈은 한 줄로', () => {
    const r = parseLocalized(JSON.stringify({ title_ko: '영업\n매니저', body_ko: 'x' }));
    expect(r.ok && r.title_ko).toBe('영업 매니저');
  });
  it('빈 출력·JSON 아님·필드 없음·너무 김을 거부', () => {
    expect(parseLocalized('  ')).toEqual({ ok: false, why: 'empty' });
    expect(parseLocalized('번역할 수 없습니다')).toEqual({ ok: false, why: 'not_json' });
    expect(parseLocalized('{"title_ko": "a", body}')).toEqual({ ok: false, why: 'not_json' });
    expect(parseLocalized('[1,2]')).toEqual({ ok: false, why: 'not_json' });
    expect(parseLocalized(JSON.stringify({ title_ko: '제목', body_ko: '' }))).toEqual({ ok: false, why: 'missing_field' });
    expect(parseLocalized(JSON.stringify({ title_ko: '제목', body_ko: 3 }))).toEqual({ ok: false, why: 'missing_field' });
    expect(parseLocalized(JSON.stringify({ title_ko: '가'.repeat(121), body_ko: 'x' }))).toEqual({ ok: false, why: 'too_long' });
    expect(parseLocalized(JSON.stringify({ title_ko: '제목', body_ko: '가'.repeat(8001) }))).toEqual({ ok: false, why: 'too_long' });
    expect(parseJsonOutput('x'.repeat(MAX_RAW_OUTPUT + 1), { a: 10 })).toEqual({ ok: false, why: 'oversized' });
  });
  it('대조본은 제목 + 빈 줄 + 본문', () =>
    expect(parseBack(JSON.stringify({ title_zh: '销售经理', body_zh: '负责' }))).toEqual({ ok: true, back_zh: '销售经理\n\n负责' }));
});

// ── 가짜 엔진으로 순서·실패 처리 확인

const KO = JSON.stringify({ title_ko: '영업 매니저', body_ko: '영업 담당' });
const BACK = JSON.stringify({ title_zh: '销售经理', body_zh: '负责销售' });

function fake(id: string, outputs: (string | Error)[], available = true): LocalizeEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    id, calls,
    available: () => available,
    async complete(_env, req) {
      calls.push(req.user);
      const o = outputs.shift();
      if (o === undefined) throw new EngineError('network');
      if (o instanceof Error) throw o;
      return o;
    },
  };
}
const input = { titleZh: '销售经理', bodyZh: '负责销售' };

describe('localizeJob', () => {
  afterEach(() => vi.restoreAllMocks());
  it('첫 엔진이 성공하면 그 엔진 결과', async () => {
    const a = fake('a', [KO, BACK]);
    expect(await localizeJob({}, input, {}, [a])).toEqual({ ok: true, engine: 'a', title_ko: '영업 매니저', body_ko: '영업 담당', back_zh: '销售经理\n\n负责销售' });
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]).toContain('영업 매니저'); // 대조본은 한국어 초안을 다시 옮긴다
  });
  it('실패하면 다음 엔진으로 (엔진당 한 번)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = fake('a', [new EngineError('http', 500)]);
    const b = fake('b', ['엉뚱한 출력']);
    const c = fake('c', [KO, BACK]);
    const r = await localizeJob({}, input, {}, [a, b, c]);
    expect(r.ok && r.engine).toBe('c');
    expect([a.calls.length, b.calls.length]).toEqual([1, 1]);
  });
  it('대조본 실패도 그 엔진의 실패로 본다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = fake('a', [KO, 'not json']);
    const b = fake('b', [KO, BACK]);
    expect((await localizeJob({}, input, {}, [a, b])).ok && 'b').toBe('b');
  });
  it('모두 실패하면 all_failed, 시도한 엔진 목록', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await localizeJob({}, input, {}, [fake('a', []), fake('b', [])])).toEqual({ ok: false, why: 'all_failed', tried: ['a', 'b'] });
  });
  it('쓸 수 있는 엔진이 없으면 no_engine', async () =>
    expect(await localizeJob({}, input, {}, [fake('a', [KO, BACK], false)])).toEqual({ ok: false, why: 'no_engine', tried: [] }));
  it('LOCALIZE_ENGINE 과 다시 만들기(after)를 따른다', async () => {
    const a = fake('a', [KO, BACK]), b = fake('b', [KO, BACK]);
    expect((await localizeJob({ LOCALIZE_ENGINE: 'b' }, input, {}, [a, b])).ok && b.calls.length).toBe(2);
    const a2 = fake('a', [KO, BACK]), b2 = fake('b', [KO, BACK]);
    const r = await localizeJob({ LOCALIZE_ENGINE: 'b' }, input, { after: 'b' }, [a2, b2]);
    expect(r.ok && r.engine).toBe('a');
  });
  it('시간 예산을 넘기면 다음 엔진을 시작하지 않는다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 0;
    const slow: LocalizeEngine = { id: 'slow', available: () => true, complete: async () => { t += 60_000; throw new EngineError('timeout'); } };
    const b = fake('b', [KO, BACK]);
    expect(await localizeJob({}, input, {}, [slow, b], () => t)).toEqual({ ok: false, why: 'all_failed', tried: ['slow'] });
  });
  it('실패 로그에는 엔진 id 와 오류 종류만 남는다', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runEngine(fake('a', [new EngineError('http', 429)]), {}, input);
    expect(r.ok).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toBe('localize: engine=a failed=http_429');
  });
  it('available() 이 예외를 던지는 엔진은 쓸 수 없는 것으로', () => {
    const bad: LocalizeEngine = { id: 'x', available: () => { throw new Error('boom'); }, complete: async () => '' };
    expect(availableEngines({}, [bad])).toEqual([]);
  });
});

// ── 어댑터: 실제 API 는 부르지 않고 fetch 를 가로채 요청 모양만 확인한다

const req = { system: 'SYS', user: 'USER', maxTokens: 100 };
const signal = new AbortController().signal;

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('어댑터', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('available: 키·바인딩이 있을 때만', () => {
    expect([claude.available({}), gemini.available({ GEMINI_API_KEY: ' ' }), workersAi.available({})]).toEqual([false, false, false]);
    expect([claude.available({ ANTHROPIC_API_KEY: 'k' }), gemini.available({ GEMINI_API_KEY: 'k' }), workersAi.available({ AI: { run: async () => ({}) } })])
      .toEqual([true, true, true]);
  });

  it('claude: x-api-key·anthropic-version 헤더, 기본 모델, text 블록만', async () => {
    const f = mockFetch({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'OUT' }] });
    expect(await claude.complete({ ANTHROPIC_API_KEY: 'sk-test' }, req, signal)).toBe('OUT');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init!.headers as Record<string, string>;
    expect([h['x-api-key'], h['anthropic-version'], h['content-type']]).toEqual(['sk-test', '2023-06-01', 'application/json']);
    expect(JSON.parse(init!.body as string)).toEqual({ model: DEFAULT_CLAUDE_MODEL, max_tokens: 100, system: 'SYS', messages: [{ role: 'user', content: 'USER' }] });
  });
  it('claude: 모델 변수, HTTP 오류는 상태만', async () => {
    const f = mockFetch({ error: { message: 'secret detail' } }, 401);
    await expect(claude.complete({ ANTHROPIC_API_KEY: 'k', LOCALIZE_CLAUDE_MODEL: 'claude-sonnet-5-5' }, req, signal)).rejects.toThrow('http_401');
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string).model).toBe('claude-sonnet-5-5');
  });

  it('gemini: 키는 헤더로(주소에 없음), system_instruction, thought 부분 제외', async () => {
    const f = mockFetch({ candidates: [{ content: { parts: [{ text: 'THINK', thought: true }, { text: 'OU' }, { text: 'T' }] } }] });
    expect(await gemini.complete({ GEMINI_API_KEY: 'g-key' }, req, signal)).toBe('OUT');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(String(url)).not.toContain('g-key');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(init!.body as string);
    expect(body.system_instruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'USER' }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });
  it('gemini: 후보가 없으면(차단 등) bad_response', async () => {
    mockFetch({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(gemini.complete({ GEMINI_API_KEY: 'k' }, req, signal)).rejects.toThrow('bad_response');
  });

  it('workers_ai: 바인딩에 messages 와 max_tokens, 두 출력 모양을 모두 읽는다', async () => {
    const run = vi.fn(async () => ({ choices: [{ message: { content: 'OUT' } }] }));
    expect(await workersAi.complete({ AI: { run } }, req, signal)).toBe('OUT');
    expect(run).toHaveBeenCalledWith(DEFAULT_WORKERS_AI_MODEL, {
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }], max_tokens: 100,
    });
    const run2 = vi.fn(async (_m: string, _i: unknown) => ({ response: 'OUT2' }));
    expect(await workersAi.complete({ AI: { run: run2 }, LOCALIZE_WORKERS_AI_MODEL: '@cf/x/y' }, req, signal)).toBe('OUT2');
    expect(run2.mock.calls[0]![0]).toBe('@cf/x/y');
  });
  it('workers_ai: 시간 제한', async () => {
    const ac = new AbortController();
    const p = workersAi.complete({ AI: { run: () => new Promise(() => {}) } }, req, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('timeout');
  });

  it('openai 호환 엔진 만들기: Bearer 헤더, /chat/completions', async () => {
    const e = openAiCompatEngine({ id: 'x', keyVar: 'X_KEY', modelVar: 'X_MODEL', defaultModel: 'm1', baseUrl: 'https://api.example.com/v1/' });
    expect(e.available({})).toBe(false);
    const f = mockFetch({ choices: [{ message: { content: 'OUT' } }] });
    const env = { X_KEY: 'xk' } as Record<string, string>;
    expect(await e.complete(env, req, signal)).toBe('OUT');
    expect(f.mock.calls[0]![0]).toBe('https://api.example.com/v1/chat/completions');
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer xk');
  });

  it('응답 글 꺼내기', () => {
    expect(chatText({ response: 'a' })).toBe('a');
    expect(chatText({ choices: [{ message: { content: 'b' } }] })).toBe('b');
    expect(chatText({ choices: [] })).toBeNull();
    expect(geminiText({ candidates: [] })).toBeNull();
    expect(claudeText({ content: [{ type: 'tool_use' }] })).toBeNull();
  });
});

describe('gemini: 혼잡하면 다음 모델', () => {
  const ok = { candidates: [{ content: { parts: [{ text: 'OUT' }] } }] };
  const seq = (...steps: Array<[number, unknown]>) => {
    let i = 0;
    const f = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      const [status, body] = steps[Math.min(i++, steps.length - 1)]!;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', f);
    return f;
  };
  const sig = () => new AbortController().signal;
  const rq = { system: 'SYS', user: 'USER', maxTokens: 100 };
  const modelOf = (call: unknown[]) => String(call[0]).match(/models\/([^:]+):/)![1];

  it('모델 목록: 기본값, 쉼표로 여러 개, 중복 제거', async () => {
    const { geminiModels, GEMINI_FALLBACK_MODELS } = await import('../src/lib/localize/engines/gemini');
    expect(geminiModels(undefined)).toEqual([DEFAULT_GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]);
    expect(geminiModels('  ')).toEqual([DEFAULT_GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]);
    expect(geminiModels('a, b ,a,,c')).toEqual(['a', 'b', 'c']);
    expect(geminiModels('only-one')).toEqual(['only-one']);
  });
  it('503(혼잡)·429(한도)·404(모델 없음)면 다음 모델로 넘어가 성공한다', async () => {
    const f = seq([503, { error: { status: 'UNAVAILABLE', message: 'high demand' } }], [429, { error: { message: 'quota' } }], [200, ok]);
    expect(await gemini.complete({ GEMINI_API_KEY: 'k', LOCALIZE_GEMINI_MODEL: 'm1,m2,m3' }, rq, sig())).toBe('OUT');
    expect(f.mock.calls.map(modelOf)).toEqual(['m1', 'm2', 'm3']);
    vi.unstubAllGlobals();
  });
  it('모두 실패하면 마지막 오류를 돌려준다', async () => {
    const f = seq([503, { error: { message: 'busy' } }]);
    await expect(gemini.complete({ GEMINI_API_KEY: 'k', LOCALIZE_GEMINI_MODEL: 'm1,m2' }, rq, sig())).rejects.toThrow('http_503');
    expect(f.mock.calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it('키 오류(401·403)·요청 오류(400)는 다른 모델을 시도하지 않는다', async () => {
    for (const status of [400, 401, 403]) {
      const f = seq([status, { error: { message: 'no' } }], [200, ok]);
      await expect(gemini.complete({ GEMINI_API_KEY: 'k', LOCALIZE_GEMINI_MODEL: 'm1,m2' }, rq, sig())).rejects.toThrow(`http_${status}`);
      expect(f.mock.calls).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
  it('응답 모양이 다르면(차단 등) 다른 모델을 시도하지 않는다', async () => {
    const f = seq([200, { promptFeedback: { blockReason: 'SAFETY' } }], [200, ok]);
    await expect(gemini.complete({ GEMINI_API_KEY: 'k', LOCALIZE_GEMINI_MODEL: 'm1,m2' }, rq, sig())).rejects.toThrow('bad_response');
    expect(f.mock.calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });
  it('바깥 제한 시간이 끝났으면 더 시도하지 않는다', async () => {
    const f = seq([200, ok]);
    const ac = new AbortController(); ac.abort();
    await expect(gemini.complete({ GEMINI_API_KEY: 'k', LOCALIZE_GEMINI_MODEL: 'm1,m2' }, rq, ac.signal)).rejects.toThrow();
    expect(f.mock.calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe('번역자 메모 감지와 지시문', () => {
  it('메모처럼 보이는 줄만 찾는다', async () => {
    const { translatorNoteLines } = await import('../src/lib/localize/prompt');
    const body = [
      '한국 구직 사이트에 오신 것을 환영합니다.',
      '',
      '[참고] 원문에 담당업무, 자격요건 등 채용 세부 내용이 포함되어 있지 않아 원문 내용만 옮겼습니다.',
      '※ 급여는 원문에 명시되어 있지 않습니다.',
      '담당업무: 한국 시장 영업',
      '자격요건: 경력 3년 이상',
      '우대사항: 중국어 가능자 (참고로 본사와 소통합니다)',
    ].join('\n');
    expect(translatorNoteLines(body)).toHaveLength(2);
    expect(translatorNoteLines('담당업무\n- 고객 개발\n자격요건\n- 경력 3년')).toEqual([]);
    expect(translatorNoteLines('')).toEqual([]);
  });
  it('초안 지시문은 메모를 금지하고, 대조본 지시문은 빠짐없이 옮기라고 한다', async () => {
    const { LOCALIZE_SYSTEM, BACK_SYSTEM } = await import('../src/lib/localize/prompt');
    expect(LOCALIZE_SYSTEM).toContain('번역자 메모');
    expect(LOCALIZE_SYSTEM).toContain('[참고]');
    expect(BACK_SYSTEM).toContain('하나도 빼지 마세요');
  });
});
