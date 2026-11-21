import type { Locale } from '../env';
import { t } from '../lib/i18n';
import type { OptionSet } from '../lib/options';
import type { PublicJobListRow } from '../db/public-jobs';
import { PublicJobItem } from './public-jobs';

/** 홈: 짧은 소개 + 최신 공개 공고 몇 건(목록과 같은 줄 모양) + 전체 목록 링크. */
export const Home = ({ locale, jobs, options, bye }: { locale: Locale; jobs: PublicJobListRow[]; options: OptionSet; bye?: boolean }) => (
  <>
    {bye && <p class="ok">{t(locale, 'home.bye')}</p>}
    <section class="hero">
      <h1>{t(locale, 'site.tagline')}</h1>
      <p>{t(locale, 'home.lead')}</p>
      <p class="muted">{t(locale, 'home.for_company')}</p>
    </section>
    <section class="wide spaced">
      <h2>{t(locale, 'home.latest')}</h2>
      {jobs.length === 0 ? <p class="muted">{t(locale, 'home.no_jobs')}</p>
        : <ul class="list">{jobs.map((r) => <PublicJobItem locale={locale} row={r} options={options} />)}</ul>}
      <p><a href="/jobs">{t(locale, 'home.all_jobs')}</a></p>
    </section>
  </>
);

export const LoginEmail = ({ locale, error }: { locale: Locale; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'login.title')}</h1>
    {error && <p class="error">{t(locale, `err.${error}`)}</p>}
    <form method="post" action="/login/request">
      <label>{t(locale, 'login.email')}
        <input type="email" name="email" required autocomplete="email" maxlength={254} />
      </label>
      <fieldset>
        <legend>{t(locale, 'login.role')}</legend>
        <label class="check"><input type="radio" name="role" value="seeker" required />{t(locale, 'login.role.seeker')}</label>
        <label class="check"><input type="radio" name="role" value="company" required />{t(locale, 'login.role.company')}</label>
        <p class="hint">{t(locale, 'login.role.hint')}</p>
      </fieldset>
      <button type="submit">{t(locale, 'login.send')}</button>
      <p class="muted">{t(locale, 'login.agree')} <a href="/terms">{t(locale, 'footer.terms')}</a> · <a href="/privacy">{t(locale, 'footer.privacy')}</a></p>
    </form>
  </section>
);

/** 고른 유형과 계정의 유형이 다를 때: 로그인은 되었고, 어느 유형으로 들어왔는지 알려 준다. */
export const LoginRoleNotice = ({ locale, actual }: { locale: Locale; actual: string }) => (
  <section class="card">
    <h1>{t(locale, 'login.rolenotice.title')}</h1>
    <p>{t(locale, 'login.rolenotice.body').replace('{role}', t(locale, `login.role.${actual}`))}</p>
    <p class="muted">{t(locale, 'login.rolenotice.hint')}</p>
    <p><a class="button" href="/my">{t(locale, 'login.rolenotice.continue')}</a></p>
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

// 구직자 첫 화면: 이력서·지원 현황 링크.
export const MySeeker = ({ locale, email }: { locale: Locale; email: string }) => (
  <section class="card">
    <h1>{t(locale, 'nav.my')}</h1>
    <p><a href="/my/resumes">{t(locale, 'my.seeker.resumes')}</a></p>
    <p class="muted">{t(locale, 'my.seeker.resumes_note')}</p>
    <p><a href="/my/applications">{t(locale, 'my.seeker.applications')}</a></p>
    <p class="muted">{t(locale, 'my.seeker.applications_note')}</p>
    <p><a href="/my/account">{t(locale, 'my.account')}</a></p>
    <p class="muted">{t(locale, 'my.account_note')}</p>
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

/** 관리자 2단계 인증. setup 이 있으면 최초 등록 화면(비밀키 표시)이다. */
export const LoginTotp = ({ locale, setup, error }: { locale: Locale; setup?: { secret: string; uri: string }; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'totp.title')}</h1>
    {setup && (
      <>
        <p>{t(locale, 'totp.setup.lead')}</p>
        <p class="secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
        <p class="muted"><a href={setup.uri}>{t(locale, 'totp.setup.link')}</a></p>
        <p class="muted">{t(locale, 'totp.setup.keep')}</p>
      </>
    )}
    {error && <p class="error">{t(locale, `err.${error}`)}</p>}
    <form method="post" action="/login/totp">
      <label>{t(locale, 'totp.code')}
        <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required autocomplete="one-time-code" autofocus />
      </label>
      <button type="submit">{t(locale, 'login.verify')}</button>
    </form>
  </section>
);

/** 관리자 첫 화면: 처리할 일의 개수만 보여준다. 기업 검증 목록은 /admin/companies, 공고 검토는 /admin/jobs, 신고 목록은 T-09 에서 만든다. */
export const AdminHome = ({ locale, counts }: { locale: Locale; counts: { companies: number; agencies: number; jobReviews: number; reports: number } }) => (
  <section class="wide">
    <h1>{t(locale, 'admin.title')}</h1>
    <ul class="stats">
      <li><a class="stat" href="/admin/companies"><b>{counts.companies}</b><span>{t(locale, 'admin.count.companies')}</span></a></li>
      <li><b>{counts.agencies}</b><span>{t(locale, 'admin.count.agencies')}</span></li>
      <li><a class="stat" href="/admin/jobs"><b>{counts.jobReviews}</b><span>{t(locale, 'admin.count.job_reviews')}</span></a></li>
      <li><b>{counts.reports}</b><span>{t(locale, 'admin.count.reports')}</span></li>
    </ul>
    <p><a href="/admin/settings">{t(locale, 'adm.set.title')}</a> · <a href="/admin/options">{t(locale, 'adm.opt.title')}</a> · <a href="/admin/access-log">{t(locale, 'adm.log.title')}</a></p>
    <p class="muted">{t(locale, 'admin.note')}</p>
  </section>
);
