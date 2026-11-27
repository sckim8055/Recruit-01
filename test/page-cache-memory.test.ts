// 공개 화면 캐시 — 서버 메모리 저장소 (T-19, src/lib/page-cache.ts MemoryPageCache): 같은 키·60초·비로그인만·크기 한도.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryPageCache, PAGE_CACHE_LIMITS, PAGE_CACHE_TTL, pageCache, PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from '../src/lib/page-cache';
import type { AppEnv } from '../src/env';

describe('MemoryPageCache', () => {
  it('60초 동안만 꺼낸다, 상태·머리글·본문 그대로 (꺼낼 때마다 새 응답)', async () => {
    let now = 1_000_000;
    const c = new MemoryPageCache(undefined, undefined, () => now);
    await c.put('k', new Response('<p>hi</p>', { status: 200, headers: { 'content-type': 'text/html', 'x-a': '1' } }));
    const a = await c.match('k');
    expect([a?.status, a?.headers.get('x-a'), await a?.text()]).toEqual([200, '1', '<p>hi</p>']);
    expect(await (await c.match('k'))?.text()).toBe('<p>hi</p>');
    now += PAGE_CACHE_TTL * 1000 - 1;
    expect(await c.match('k')).toBeDefined();
    now += 1;
    expect(await c.match('k')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('크기 한도: 항목 수·합계를 넘으면 오래 넣은 것부터 버리고, 너무 큰 응답은 넣지 않는다', async () => {
    const c = new MemoryPageCache(60_000, { entries: 3, entryBytes: 10, totalBytes: 25 });
    for (const k of ['a', 'b', 'c', 'd']) await c.put(k, new Response('12345'));
    expect([await c.match('a'), (await c.match('d')) !== undefined]).toEqual([undefined, true]);
    expect(c.size).toBe(3);
    await c.put('big', new Response('x'.repeat(11)));
    expect(await c.match('big')).toBeUndefined();
    await c.put('e', new Response('1234567890'));
    await c.put('f', new Response('1234567890'));
    expect(c.totalBytes).toBeLessThanOrEqual(25);
    expect(PAGE_CACHE_LIMITS.entries).toBe(500);
    c.clear();
    expect([c.size, c.totalBytes]).toEqual([0, 0]);
  });
});

describe('pageCache 미들웨어 + env.PAGE_CACHE', () => {
  function app(cache: MemoryPageCache | undefined) {
    let renders = 0;
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => { c.set('user', null); c.set('locale', 'ko'); await next(); });
    a.get('/jobs', pageCache, (c) => { renders++; return c.html(`<p>list ${renders}</p>`); });
    a.get('/gone', pageCache, (c) => c.html('nope', 404));
    const env = { PAGE_CACHE: cache } as never;
    return { get: (p: string, h: Record<string, string> = {}) => a.fetch(new Request(`https://recruit.example.test${p}`, { headers: h }), env), renders: () => renders };
  }

  it('비로그인: 첫 요청 miss → 다음 요청 hit (다시 그리지 않음), 검색 조건 순서가 달라도 같은 항목', async () => {
    const w = app(new MemoryPageCache());
    const r1 = await w.get('/jobs?b=2&a=1');
    expect([r1.headers.get('x-page-cache'), r1.headers.get('cache-control'), await r1.text()]).toEqual(['miss', PUBLIC_CACHE_CONTROL, '<p>list 1</p>']);
    const r2 = await w.get('/jobs?a=1&b=2');
    expect([r2.headers.get('x-page-cache'), await r2.text()]).toEqual(['hit', '<p>list 1</p>']);
    expect(w.renders()).toBe(1);
  });

  it('로그인 쿠키가 있으면 읽지도 쓰지도 않는다 · 404 는 넣지 않는다 · 캐시가 없으면(테스트 기본) 그대로', async () => {
    const cache = new MemoryPageCache();
    const w = app(cache);
    const r = await w.get('/jobs', { cookie: 'sid=x' });
    expect([r.headers.get('x-page-cache'), r.headers.get('cache-control')]).toEqual(['bypass', PRIVATE_CACHE_CONTROL]);
    expect(cache.size).toBe(0);
    expect((await w.get('/gone')).headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    expect(cache.size).toBe(0);
    const none = app(undefined);
    await none.get('/jobs');
    expect(await (await none.get('/jobs')).text()).toBe('<p>list 2</p>');
  });
});
