import type { Context } from 'hono';
import { html } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { AppEnv } from './env';
import { t } from './lib/i18n';
import { Layout } from './views/layout';

/** 페이지를 공통 레이아웃에 넣어 응답한다. titleKey 는 locales 의 키. */
export function render(c: Context<AppEnv>, body: Child, titleKey?: string, status: 200 | 400 | 403 | 404 = 200) {
  const page = (
    <Layout
      locale={c.var.locale}
      user={c.var.user}
      title={titleKey ? t(c.var.locale, titleKey) : undefined}
      appEnv={c.env.APP_ENV}
      registrationNo={c.env.REGISTRATION_NO}
      path={new URL(c.req.url).pathname}
    >
      {body}
    </Layout>
  );
  return c.html(html`<!DOCTYPE html>${page}`, status);
}
