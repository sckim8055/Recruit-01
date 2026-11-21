import type { Context } from 'hono';
import { html } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { AppEnv } from './env';
import { t } from './lib/i18n';
import { Layout } from './views/layout';
import { ErrorPage } from './views/pages';

/**
 * 페이지를 공통 레이아웃에 넣어 응답한다. titleKey 는 locales 의 키.
 * 공고 제목처럼 문구 키가 아닌 글을 탭 제목으로 쓰려면 { text } 로 넘긴다 (JSX 로 출력되므로 이스케이프된다).
 */
export function render(c: Context<AppEnv>, body: Child, titleKey?: string | { text: string }, status: 200 | 400 | 403 | 404 | 413 | 503 = 200) {
  const page = (
    <Layout
      locale={c.var.locale}
      user={c.var.user}
      title={typeof titleKey === 'object' ? titleKey.text : titleKey ? t(c.var.locale, titleKey) : undefined}
      appEnv={c.env.APP_ENV}
      registrationNo={c.env.REGISTRATION_NO}
      path={pathAndSearch(c.req.url)}
    >
      {body}
    </Layout>
  );
  return c.html(html`<!DOCTYPE html>${page}`, status);
}

/**
 * 언어 전환 링크(/lang/:l?to=)가 돌아올 주소: 검색 조건(공고 필터 등)도 유지한다.
 * ?lang= 은 뺀다 — 남기면 돌아온 주소의 ?lang= 이 방금 바꾼 쿠키보다 앞서서(detectLocale) 언어가 바뀌지 않는다.
 */
export function pathAndSearch(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('lang');
  return u.pathname + u.search;
}

/** 403·404 화면을 공통 레이아웃으로 응답한다. (auth.ts 의 requireRole 도 이것을 쓴다 — render.tsx 는 auth.ts 를 import 하지 않는다) */
export function renderError(c: Context<AppEnv>, code: 403 | 404) {
  return render(c, <ErrorPage locale={c.var.locale} code={code} />, code === 403 ? 'forbidden.title' : 'notfound.title', code);
}
