import type { Locale } from '../env';
import type { DemoAccount } from '../lib/demo';
import { t } from '../lib/i18n';
import { qrSvgPath } from '../lib/qr';
import type { OptionSet } from '../lib/options';
import type { PublicJobListRow } from '../db/public-jobs';
import { PublicJobItem } from './public-jobs';

/** 이용 방법 단계 (구직자 3 · 기업 3). 문구 키: home.how.<who>.<n>.t / .d */
const HOW_STEPS = [1, 2, 3] as const;
/** "이 사이트가 다른 점" — 각 항목이 코드로 참인지는 docs/ARCHITECTURE.md "디자인 규칙 > 첫 화면 문구" 에 적어 둔다. */
const HOME_POINTS = [1, 2, 3, 4] as const;
/** 자주 묻는 질문. 문의처는 운영자 정보(src/legal/types.ts OPERATOR)가 【확인 필요】인 동안 넣지 않는다. */
const HOME_FAQ = ['cost', 'who_posts', 'no_referral', 'who_sees', 'delete'] as const;

const Steps = ({ locale, who }: { locale: Locale; who: 'seeker' | 'company' }) => (
  <div class="box">
    <h3>{t(locale, `home.how.${who}`)}</h3>
    <ol class="steps">
      {HOW_STEPS.map((n) => (
        <li><b>{t(locale, `home.how.${who}.${n}.t`)}</b><span>{t(locale, `home.how.${who}.${n}.d`)}</span></li>
      ))}
    </ol>
  </div>
);

/**
 * 홈(첫 화면). 비로그인 요청은 page-cache 로 캐시되므로 사용자별 내용을 넣지 않는다 (bye 안내는 캐시를 거치지 않는 ?bye=1 에서만).
 * 읽는 데이터는 예전과 같다: 최신 공개 공고 몇 건 + 직무·업계·근무지 이름 (routes/jobs.homePage). 나머지는 고정 문구.
 */
export const Home = ({ locale, jobs, options, bye }: { locale: Locale; jobs: PublicJobListRow[]; options: OptionSet; bye?: boolean }) => (
  <>
    {bye && <p class="ok">{t(locale, 'home.bye')}</p>}
    <section class="hero">
      <h1>{t(locale, 'site.tagline')}</h1>
      <p class="lead">{t(locale, 'home.hero.lead')}</p>
      <div class="actions">
        <a class="button" href="/jobs">{t(locale, 'home.cta.jobs')}</a>
        <a class="button plain" href="/biz">{t(locale, 'home.cta.company')}</a>
      </div>
      <p class="hint">{t(locale, 'home.cta.company_note')}</p>
    </section>

    <section class="home-sec">
      <h2>{t(locale, 'home.how.title')}</h2>
      <div class="two">
        <Steps locale={locale} who="seeker" />
        <Steps locale={locale} who="company" />
      </div>
    </section>

    <section class="home-sec">
      <h2>{t(locale, 'home.points.title')}</h2>
      <ul class="points">
        {HOME_POINTS.map((n) => <li><b>{t(locale, `home.points.${n}.t`)}</b><span>{t(locale, `home.points.${n}.d`)}</span></li>)}
      </ul>
    </section>

    <section class="home-sec">
      <h2>{t(locale, 'home.latest')}</h2>
      {jobs.length === 0 ? <div class="box"><p class="muted">{t(locale, 'home.no_jobs')}</p></div>
        : <ul class="list">{jobs.map((r) => <PublicJobItem locale={locale} row={r} options={options} />)}</ul>}
      <p class="more"><a href="/jobs">{t(locale, 'home.all_jobs')}</a></p>
    </section>

    <section class="home-sec faq">
      <h2>{t(locale, 'home.faq.title')}</h2>
      {HOME_FAQ.map((k) => (
        <details>
          <summary>{t(locale, `home.faq.${k}.q`)}</summary>
          <p>{t(locale, `home.faq.${k}.a`)}</p>
        </details>
      ))}
    </section>
  </>
);

/** demo: 시연 로그인이 켜져 있을 때만 넘어온다 (테스트 서버·로컬 — lib/demo.ts). 넘어오지 않으면 시연 계정 칸을 그리지 않는다. */
export const LoginEmail = ({ locale, error, demo }: { locale: Locale; error?: string; demo?: readonly DemoAccount[] }) => (
  <>
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
  {demo && demo.length > 0 && (
    <section class="card">
      <h2>{t(locale, 'demo.title')}</h2>
      <p>{t(locale, 'demo.lead')}</p>
      <form method="post" action="/login/demo">
        {demo.map((a) => (
          <p>
            <button type="submit" name="account" value={a.key}>{t(locale, `demo.acct.${a.key}`)}</button>
            <br /><span class="hint">{t(locale, `demo.acct.${a.key}.d`)}</span>
          </p>
        ))}
      </form>
      <p class="muted">{t(locale, 'demo.note')}</p>
    </section>
  )}
  </>
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
    <p><a href="/my/alerts">{t(locale, 'my.seeker.alerts')}</a></p>
    <p class="muted">{t(locale, 'my.seeker.alerts_note')}</p>
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

/** 점검 모드 안내 (T-13, 503). 개인정보·링크 없이 한 줄 안내만 — 다른 화면으로 가도 같은 안내가 나온다. */
export const MaintenancePage = ({ locale }: { locale: Locale }) => (
  <section class="card">
    <h1>{t(locale, 'maint.title')}</h1>
    <p>{t(locale, 'maint.body')}</p>
    <p class="muted">{t(locale, 'maint.later')}</p>
  </section>
);

/** 인증 앱으로 스캔하는 QR 코드. 서버에서 SVG 로 그린다 (외부 서비스·스크립트 없음, lib/qr.ts). 주소가 너무 길면 그리지 않는다. */
const TotpQr = ({ uri, label }: { uri: string; label: string }) => {
  const qr = qrSvgPath(uri);
  if (!qr) return null;
  return (
    <p class="qr">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${qr.size} ${qr.size}`} width="220" height="220" role="img" aria-label={label} shape-rendering="crispEdges">
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.d} fill="#000" />
      </svg>
    </p>
  );
};

/** 관리자 2단계 인증. setup 이 있으면 최초 등록 화면(비밀키 표시)이다. */
export const LoginTotp = ({ locale, setup, error }: { locale: Locale; setup?: { secret: string; uri: string }; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'totp.title')}</h1>
    {setup && (
      <>
        <p>{t(locale, 'totp.setup.lead')}</p>
        <TotpQr uri={setup.uri} label={t(locale, 'totp.setup.qr_alt')} />
        <p class="muted">{t(locale, 'totp.setup.manual')}</p>
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
export interface AdminUsage { day: string; localize: { n: number; limit: number }; mail: { n: number; limit: number } }

export const AdminHome = ({ locale, counts, usage }: {
  locale: Locale; counts: { companies: number; agencies: number; jobReviews: number; reports: number }; usage?: AdminUsage;
}) => (
  <section class="wide">
    <h1>{t(locale, 'admin.title')}</h1>
    <ul class="stats">
      <li><a class="stat" href="/admin/companies"><b>{counts.companies}</b><span>{t(locale, 'admin.count.companies')}</span></a></li>
      <li><b>{counts.agencies}</b><span>{t(locale, 'admin.count.agencies')}</span></li>
      <li><a class="stat" href="/admin/jobs"><b>{counts.jobReviews}</b><span>{t(locale, 'admin.count.job_reviews')}</span></a></li>
      <li><b>{counts.reports}</b><span>{t(locale, 'admin.count.reports')}</span></li>
    </ul>
    {usage && <div class="box usage">
      <h2>{t(locale, 'admin.usage.title')} <span class="muted">({usage.day})</span></h2>
      <div class="table-wrap"><table>
        <tbody>
          <tr><th>{t(locale, 'admin.usage.localize')}</th><td>{usage.localize.n} / {usage.localize.limit}</td></tr>
          <tr><th>{t(locale, 'admin.usage.mail')}</th><td>{usage.mail.n} / {usage.mail.limit}</td></tr>
        </tbody>
      </table></div>
      <p class="hint">{t(locale, 'admin.usage.note')}</p>
    </div>}
    <ul class="menu">
      <li><a href="/admin/settings">{t(locale, 'adm.set.title')}</a></li>
      <li><a href="/admin/options">{t(locale, 'adm.opt.title')}</a></li>
      <li><a href="/admin/access-log">{t(locale, 'adm.log.title')}</a></li>
      <li><a href="/admin/system">{t(locale, 'sys.title')}</a></li>
    </ul>
    <p class="muted">{t(locale, 'admin.note')}</p>
  </section>
);
