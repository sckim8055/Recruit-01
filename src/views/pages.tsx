import type { Locale } from '../env';
import { t } from '../lib/i18n';

export const Home = ({ locale }: { locale: Locale }) => (
  <section class="hero">
    <h1>{t(locale, 'site.tagline')}</h1>
    <p>{t(locale, 'home.lead')}</p>
    <p class="muted">{t(locale, 'home.for_company')}</p>
  </section>
);

export const LoginEmail = ({ locale, error }: { locale: Locale; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'login.title')}</h1>
    {error && <p class="error">{t(locale, `err.${error}`)}</p>}
    <form method="post" action="/login/request">
      <label>{t(locale, 'login.email')}
        <input type="email" name="email" required autocomplete="email" maxlength={254} />
      </label>
      <label>{t(locale, 'login.role')}
        <select name="role">
          <option value="seeker">{t(locale, 'login.role.seeker')}</option>
          <option value="company">{t(locale, 'login.role.company')}</option>
        </select>
      </label>
      <button type="submit">{t(locale, 'login.send')}</button>
      <p class="muted">{t(locale, 'login.agree')}</p>
    </form>
  </section>
);

export const LoginCode = ({ locale, email, role, error }: { locale: Locale; email: string; role: string; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'login.title')}</h1>
    <p class="muted">{t(locale, 'login.sent')}</p>
    {error && <p class="error">{t(locale, `err.${error}`)}</p>}
    <form method="post" action="/login/verify">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="role" value={role} />
      <label>{t(locale, 'login.code')}
        <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required autocomplete="one-time-code" />
      </label>
      <button type="submit">{t(locale, 'login.verify')}</button>
    </form>
  </section>
);

// 구직자 첫 화면. 지원 현황은 T-08 에서 채운다.
export const MySeeker = ({ locale, email }: { locale: Locale; email: string }) => (
  <section class="card">
    <h1>{t(locale, 'nav.my')}</h1>
    <p>{t(locale, 'my.seeker.applications_soon')}</p>
    <p class="muted">{email}</p>
  </section>
);

/** 아직 내용이 없는 화면 (제목 + 한 줄). textKey 는 locales 의 키. */
export const Placeholder = ({ locale, titleKey, textKey }: { locale: Locale; titleKey: string; textKey: string }) => (
  <section class="card">
    <h1>{t(locale, titleKey)}</h1>
    <p>{t(locale, textKey)}</p>
  </section>
);

/** 403·404 화면. */
export const ErrorPage = ({ locale, code }: { locale: Locale; code: 403 | 404 }) => {
  const k = code === 403 ? 'forbidden' : 'notfound';
  return (
    <section class="card">
      <h1>{t(locale, `${k}.title`)}</h1>
      <p>{t(locale, `${k}.body`)}</p>
      <p><a href="/">{t(locale, 'common.home')}</a></p>
    </section>
  );
};
