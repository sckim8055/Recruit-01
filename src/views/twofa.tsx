// 2단계 인증 화면 (T-16): 계정 화면의 블록, /my/account/2fa(켜기·재등록·복구 코드), 끄기, 복구 코드 표시, 관리자 초기화. 자바스크립트 없음.
// 복구 코드는 만든 응답에서 한 번만 그린다. 모든 화면은 private, no-store (routes/account.tsx · routes/admin-users.tsx · routes/auth.tsx).
import type { Locale, Role } from '../env';
import { fmtDateTime } from '../lib/company';
import { t } from '../lib/i18n';
import { formatRecoveryCode } from '../lib/recovery';
import type { TwofaOverview } from '../lib/twofa';
import { TotpSetup } from './pages';

const CodeInput = ({ locale, recovery }: { locale: Locale; recovery: boolean }) => (
  <label>{t(locale, recovery ? 'totp.code_or_recovery' : 'totp.code')}
    {recovery
      ? <input name="code" maxlength={20} required autocomplete="one-time-code" autocapitalize="characters" />
      : <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required autocomplete="one-time-code" />}
    {recovery && <span class="hint">{t(locale, 'totp.code_or_recovery.hint')}</span>}
  </label>
);

/** 계정 화면(/my/account)의 2단계 인증 상자: 상태·켠 시각·남은 복구 코드 수, 설정 화면 링크. */
export const TwofaBox = ({ locale, role, enabled, since, remaining }: { locale: Locale; role: Role; enabled: boolean; since: number | null; remaining: number }) => (
  <div class="box">
    <h2>{t(locale, 'tfa.title')}</h2>
    <dl class="kv">
      <dt>{t(locale, 'tfa.status')}</dt>
      <dd>{enabled ? t(locale, 'tfa.on').replace('{at}', fmtDateTime(since)) : t(locale, 'tfa.off')}</dd>
      {enabled && <><dt>{t(locale, 'tfa.remaining')}</dt><dd>{t(locale, 'tfa.remaining.n').replace('{n}', String(remaining))}</dd></>}
    </dl>
    {enabled && remaining <= 2 && <p class="warn">{t(locale, 'tfa.remaining.low')}</p>}
    <p class="muted">{t(locale, role === 'admin' ? 'tfa.lead.admin' : 'tfa.lead')}</p>
    <p><a href="/my/account/2fa">{t(locale, enabled || role === 'admin' ? 'tfa.manage' : 'tfa.enable.go')}</a></p>
  </div>
);

/** /my/account/2fa: 켜져 있지 않으면 켜기 안내, 켜져 있으면 재등록·복구 코드·(회원만) 끄기. 이 세션에서 등록 중이면 새 키와 확인 칸. */
export const TwofaPage = ({ locale, role, o, ok, error }: { locale: Locale; role: Role; o: TwofaOverview; ok?: string; error?: string }) => {
  const l = locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/my/account">{t(l, 'acct.title')}</a></p>
      <h1>{t(l, 'tfa.title')}</h1>
      <p class="sub muted">{t(l, 'tfa.apps')}</p>
      {ok && <p class="ok">{t(l, `tfa.ok.${ok}`)}</p>}
      {error && <p class="error">{t(l, `tfa.err.${error}`)}</p>}
      {o.enrolling ? (
        <div class="box">
          <h2>{t(l, o.enabled ? 'tfa.reenrol.step2' : 'tfa.enable.step2')}</h2>
          <p>{t(l, 'tfa.scan')}</p>
          <TotpSetup locale={l} secret={o.enrolling.secret} uri={o.enrolling.uri} />
          {o.enabled && <p class="muted">{t(l, 'tfa.reenrol.old_valid')}</p>}
          <form method="post" action="/my/account/2fa/confirm">
            <CodeInput locale={l} recovery={false} />
            <div class="actions">
              <button type="submit">{t(l, 'tfa.confirm')}</button>
            </div>
          </form>
          <form method="post" action="/my/account/2fa/cancel" class="inline"><button type="submit" class="link">{t(l, 'tfa.cancel')}</button></form>
        </div>
      ) : !o.enabled ? (
        <div class="box">
          <h2>{t(l, 'tfa.enable.title')}</h2>
          <p>{t(l, 'tfa.enable.lead')}</p>
          <ul>
            <li>{t(l, 'tfa.enable.1')}</li>
            <li>{t(l, 'tfa.enable.2')}</li>
            <li>{t(l, 'tfa.enable.3')}</li>
          </ul>
          <form method="post" action="/my/account/2fa/start"><button type="submit">{t(l, 'tfa.enable.start')}</button></form>
        </div>
      ) : (
        <>
          <div class="box">
            <dl class="kv">
              <dt>{t(l, 'tfa.status')}</dt><dd>{t(l, 'tfa.on').replace('{at}', fmtDateTime(o.since))}</dd>
              <dt>{t(l, 'tfa.remaining')}</dt><dd>{t(l, 'tfa.remaining.n').replace('{n}', String(o.remaining))}</dd>
            </dl>
            {o.remaining <= 2 && <p class="warn">{t(l, 'tfa.remaining.low')}</p>}
          </div>
          <div class="box">
            <h2>{t(l, 'tfa.reenrol.title')}</h2>
            <p>{t(l, 'tfa.reenrol.lead')}</p>
            <form method="post" action="/my/account/2fa/reenrol">
              <CodeInput locale={l} recovery />
              <button type="submit">{t(l, 'tfa.reenrol.next')}</button>
            </form>
          </div>
          <div class="box">
            <h2>{t(l, 'tfa.codes.title')}</h2>
            <p>{t(l, 'tfa.codes.lead')}</p>
            <form method="post" action="/my/account/2fa/codes">
              <CodeInput locale={l} recovery={false} />
              <button type="submit" class="plain">{t(l, 'tfa.codes.make')}</button>
            </form>
          </div>
          <div class="box">
            <h2>{t(l, 'tfa.lost.title')}</h2>
            <p class="muted">{t(l, role === 'admin' ? 'totp.lost.admin' : 'totp.lost.member')}</p>
            {role !== 'admin' && <p><a class="danger" href="/my/account/2fa/off">{t(l, 'tfa.off.go')}</a></p>}
          </div>
        </>
      )}
    </section>
  );
};

/** 끄기 화면 (회원만): 지금 번호 또는 복구 코드가 있어야 한다. */
export const TwofaOffPage = ({ locale, error }: { locale: Locale; error?: string }) => (
  <section class="card">
    <h1>{t(locale, 'tfa.off.title')}</h1>
    <p>{t(locale, 'tfa.off.lead')}</p>
    {error && <p class="error">{t(locale, `tfa.err.${error}`)}</p>}
    <form method="post" action="/my/account/2fa/off">
      <CodeInput locale={locale} recovery />
      <div class="actions">
        <button type="submit" class="secondary">{t(locale, 'tfa.off.submit')}</button>
        <a href="/my/account/2fa">{t(locale, 'tfa.back')}</a>
      </div>
    </form>
    <p class="muted">{t(locale, 'totp.lost.member')}</p>
  </section>
);

/** 복구 코드를 한 번만 보여 준다. next = "저장했습니다 → 계속" 이 가는 곳. */
export const RecoveryCodesShown = ({ locale, codes, next, lead }: { locale: Locale; codes: string[]; next: string; lead?: string }) => (
  <section class="card">
    <h1>{t(locale, 'rc.title')}</h1>
    {lead && <p class="ok">{t(locale, lead)}</p>}
    <p>{t(locale, 'rc.lead')}</p>
    <ol class="codes">{codes.map((c) => <li>{formatRecoveryCode(c)}</li>)}</ol>
    <p class="muted">{t(locale, 'rc.once')}</p>
    <p><a class="button" href={next}>{t(locale, 'rc.saved')}</a></p>
  </section>
);

/** 복구 코드로 로그인했다: 남은 개수와 재등록 안내. */
export const RecoveryUsedNotice = ({ locale, left, next }: { locale: Locale; left: number; next: string }) => (
  <section class="card">
    <h1>{t(locale, 'rc.used.title')}</h1>
    <p>{t(locale, 'rc.used.body').replace('{n}', String(left))}</p>
    <p><a class="button" href="/my/account/2fa">{t(locale, 'rc.used.reenrol')}</a></p>
    <p><a href={next}>{t(locale, 'rc.used.later')}</a></p>
  </section>
);

// ───────── 관리자: 회원 2단계 인증 초기화

export const AdminResetForm = ({ locale, email, reason, error, done }: { locale: Locale; email?: string; reason?: string; error?: string; done?: boolean }) => (
  <section class="wide">
    <p class="crumbs"><a href="/admin">{t(locale, 'admin.title')}</a></p>
    <h1>{t(locale, 'tfr.title')}</h1>
    <p class="sub muted">{t(locale, 'tfr.lead')}</p>
    {done && <p class="ok">{t(locale, 'tfr.done')}</p>}
    {error && <p class="error">{t(locale, `tfr.err.${error}`)}</p>}
    <form method="post" action="/admin/users/2fa-reset" class="box">
      <label>{t(locale, 'tfr.email')}
        <input type="email" name="email" required maxlength={254} autocomplete="off" value={email ?? ''} />
      </label>
      <label>{t(locale, 'tfr.reason')}
        <textarea name="reason" required minlength={10} maxlength={500} rows={3}>{reason ?? ''}</textarea>
        <span class="hint">{t(locale, 'tfr.reason.hint')}</span>
      </label>
      <button type="submit">{t(locale, 'tfr.next')}</button>
    </form>
    <p class="muted">{t(locale, 'tfr.admin_note')}</p>
  </section>
);

export const AdminResetConfirm = ({ locale, email, role, reason }: { locale: Locale; email: string; role: string; reason: string }) => (
  <section class="card">
    <h1>{t(locale, 'tfr.confirm.title')}</h1>
    <dl class="kv">
      <dt>{t(locale, 'tfr.email')}</dt><dd>{email}</dd>
      <dt>{t(locale, 'acct.type')}</dt><dd>{t(locale, `acct.role.${role}`)}</dd>
      <dt>{t(locale, 'tfr.reason')}</dt><dd>{reason}</dd>
    </dl>
    <ul>
      <li>{t(locale, 'tfr.confirm.1')}</li>
      <li>{t(locale, 'tfr.confirm.2')}</li>
      <li>{t(locale, 'tfr.confirm.3')}</li>
    </ul>
    <form method="post" action="/admin/users/2fa-reset/confirm">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="reason" value={reason} />
      <div class="actions">
        <button type="submit" class="secondary">{t(locale, 'tfr.confirm.submit')}</button>
        <a href="/admin/users/2fa-reset">{t(locale, 'tfa.back')}</a>
      </div>
    </form>
  </section>
);
