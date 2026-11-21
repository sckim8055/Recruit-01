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

export const My = ({ locale, email, role }: { locale: Locale; email: string; role: string }) => (
  <section class="card">
    <h1>{t(locale, 'nav.my')}</h1>
    <p>{t(locale, 'my.hello')}</p>
    <p class="muted">{email} · {role}</p>
  </section>
);
