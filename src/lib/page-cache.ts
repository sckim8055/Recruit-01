// 공개 화면(/, /jobs, /jobs/:id) 캐시. 로그인하지 않은 요청이 몰려도 D1 을 덜 읽게 한다.
//
// 동작
// - 로그인 쿠키(sid)가 없는 GET 만 캐시한다. 쿠키가 있으면(만료된 쿠키라도) 캐시를 읽지도 쓰지도 않고
//   `Cache-Control: private, no-store` 를 보낸다 (머리글에 계정 메뉴가 나오는 화면이므로).
// - 캐시 키는 pageCacheKey(): 주소(경로 + 정렬한 검색 조건) + 판별된 언어. 같은 주소라도 언어가 다르면 다른 항목이다.
//   언어는 ?lang= → lang 쿠키 → Accept-Language 순으로 정해지므로(lib/i18n.detectLocale), 주소만으로는 언어를 알 수 없다.
// - 브라우저에는 `Cache-Control: public, max-age=60` 과 `Vary: Cookie, Accept-Language` 를 보낸다.
//   Vary 는 브라우저 자신의 캐시를 위한 것이다: /lang/zh 로 lang 쿠키가 바뀌거나 로그인으로 sid 쿠키가 생기면
//   Cookie 머리글이 달라지므로 브라우저가 60초 안이라도 저장해 둔 한국어·비로그인 화면을 다시 쓰지 않는다.
//   (Cloudflare 의 Cache API 는 Vary 를 보지 않는다 — 그래서 서버 쪽은 키에 언어를 직접 넣는다.)
// - 200 응답이고 Set-Cookie 가 없을 때만 저장한다. 404 등은 저장하지 않고 no-store.
// - 캐시에 들어가는 화면에는 사용자별 내용이 없어야 한다: 비로그인 머리글·공개 공고만 있다.
//
// 주의: 마감·차단·게재 중단된 공고도 최대 PAGE_CACHE_TTL(60초) 동안 캐시에서 보일 수 있다 (docs/ARCHITECTURE.md 9장).
// caches.default 가 없는 곳(vitest)에서는 캐시 없이 그대로 응답한다.
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Locale } from '../env';

export const PAGE_CACHE_TTL = 60;
export const PUBLIC_CACHE_CONTROL = `public, max-age=${PAGE_CACHE_TTL}`;
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
export const PAGE_VARY = 'Cookie, Accept-Language';
const SESSION_COOKIE = 'sid';

/**
 * 캐시 키 (순수 함수). 검색 조건은 이름 순으로 정렬하고(값 순서는 유지), 언어를 `__locale` 로 붙인다.
 * 원래 주소에 `__locale` 이 있어도 지우고 판별된 언어로 덮어쓴다 (키를 바꿔치기하지 못하게).
 * 해시(#)는 서버로 오지 않으므로 다루지 않는다.
 */
export function pageCacheKey(rawUrl: string, locale: Locale): string {
  const u = new URL(rawUrl);
  const entries = [...u.searchParams.entries()].filter(([k]) => k !== '__locale');
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const p = new URLSearchParams(entries);
  p.append('__locale', locale);
  return `${u.origin}${u.pathname}?${p.toString()}`;
}

function getCache(): Cache | null {
  // [Workers] caches.default 는 Cloudflare Workers 전용. vitest·다른 실행 환경에는 없다.
  const cs = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return cs?.default ?? null;
}

function setPublicHeaders(h: Headers, state: 'hit' | 'miss'): void {
  h.set('Cache-Control', PUBLIC_CACHE_CONTROL);
  h.set('Vary', PAGE_VARY);
  h.set('X-Page-Cache', state);
}

/** 라우트에 붙이는 미들웨어. app.get('/', pageCache, handler) 처럼 언어·세션 미들웨어 뒤에서 쓴다. */
export const pageCache: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET') return next();

  const loggedIn = c.var.user != null || getCookie(c, SESSION_COOKIE) !== undefined;
  if (loggedIn) {
    await next();
    c.res.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    c.res.headers.set('Vary', PAGE_VARY);
    c.res.headers.set('X-Page-Cache', 'bypass');
    return;
  }

  const cache = getCache();
  const key = pageCacheKey(c.req.url, c.var.locale);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      // 캐시에서 꺼낸 응답의 머리글은 바꿀 수 없을 수 있어 복사본을 만든다 (뒤의 secureHeaders 가 머리글을 붙인다).
      const res = new Response(hit.body, hit);
      setPublicHeaders(res.headers, 'hit');
      return res;
    }
  }

  await next();
  const res = c.res;
  if (res.status !== 200 || res.headers.has('Set-Cookie')) {
    res.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    res.headers.set('Vary', PAGE_VARY);
    return;
  }
  setPublicHeaders(res.headers, 'miss');
  if (cache) {
    const put = cache.put(key, res.clone());
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put; // executionCtx 가 없는 실행 환경
    }
  }
};
