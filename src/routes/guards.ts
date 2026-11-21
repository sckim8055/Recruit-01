// 지원서 열람 화면(T-09)의 공통 미들웨어. 권한 검사(requireRole)보다 먼저 붙인다 — 로그인 리다이렉트·403 에도 no-store 가 붙게.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

export const NO_STORE = 'private, no-store';

/** 응답마다 Cache-Control: private, no-store (공유 캐시·브라우저가 지원서 화면을 저장하지 않게). */
export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', NO_STORE);
};

/**
 * 열면 기록이 남는 화면은 사람이 직접 연 GET 만 받는다.
 * - HEAD: Hono 는 HEAD 를 GET 처리기로 돌리므로(본문만 버림) 그대로 두면 HEAD 한 번이 열람 기록·'viewed' 를 만든다 → 405.
 * - 브라우저의 미리 가져오기·미리 그리기(Sec-Purpose / Purpose: prefetch·prerender) → 503 (명세상 거절 응답, 나중에 사람이 열면 정상 GET).
 * 처리기는 GET 으로만 등록한다. POST 는 그대로 통과한다.
 */
export const humanGetOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': NO_STORE } });
  const purpose = `${c.req.header('sec-purpose') ?? ''} ${c.req.header('purpose') ?? ''}`;
  if (/prefetch|prerender/i.test(purpose)) return new Response(null, { status: 503, headers: { 'Cache-Control': NO_STORE } });
  await next();
};
