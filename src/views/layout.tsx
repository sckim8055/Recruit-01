// 공통 레이아웃. 외부 폰트·스크립트를 쓰지 않는다 (중국에서 Google 계열이 차단되므로 시스템 폰트만 사용).
import type { Child } from 'hono/jsx';
import type { Locale, SessionUser } from '../env';
import { t } from '../lib/i18n';

export interface LayoutProps {
  locale: Locale;
  user: SessionUser | null;
  title?: string;
  appEnv: string;
  registrationNo: string;
  path: string;
  children?: Child;
}

export const Layout = (p: LayoutProps) => {
  const other: Locale = p.locale === 'ko' ? 'zh' : 'ko';
  return (
    <html lang={p.locale === 'ko' ? 'ko' : 'zh-CN'}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{p.title ? `${p.title} · ` : ''}{t(p.locale, 'site.name')}</title>
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        {p.appEnv !== 'production' && <div class="envbar">{t(p.locale, 'footer.test')}</div>}
        <header class="top">
          <a class="brand" href="/">{t(p.locale, 'site.name')}</a>
          <nav>
            <a href="/jobs">{t(p.locale, 'nav.jobs')}</a>
            <a href="/companies">{t(p.locale, 'nav.companies')}</a>
            {p.user ? (
              <>
                <a href="/my">{t(p.locale, 'nav.my')}</a>
                <form method="post" action="/logout" class="inline">
                  <button type="submit" class="link">{t(p.locale, 'nav.logout')}</button>
                </form>
              </>
            ) : (
              <a href="/login">{t(p.locale, 'nav.login')}</a>
            )}
            <a class="lang" href={`/lang/${other}?to=${encodeURIComponent(p.path)}`}>{other === 'zh' ? '中文' : '한국어'}</a>
          </nav>
        </header>
        <main>{p.children}</main>
        <footer>
          <p>{t(p.locale, 'footer.disclaimer')}</p>
          {p.registrationNo && <p>{t(p.locale, 'footer.registration')}: {p.registrationNo}</p>}
        </footer>
      </body>
    </html>
  );
};
