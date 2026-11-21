// 동의 화면(/consent)·계정 화면(/my/account)·탈퇴 확인 화면(/my/account/delete) (T-11). 자바스크립트 없이 폼만 쓴다.
import type { Locale, Role } from '../env';
import type { DeletionBlock } from '../lib/account';
import type { ConsentRow, RequiredConsent, RequiredConsentItem } from '../lib/consent';
import { t } from '../lib/i18n';
import type { RetentionValues } from '../lib/retention';
import { tRetention } from '../legal/render';

const DocLinks = ({ locale }: { locale: Locale }) => (
  <p><a href="/terms">{t(locale, 'footer.terms')}</a> · <a href="/privacy">{t(locale, 'footer.privacy')}</a></p>
);

const items = (locale: Locale, types: RequiredConsent[]) => types.map((x) => t(locale, `consent.item.${x}`)).join(', ');

/**
 * 동의 화면. missing = 아직 받지 않은 항목(체크 칸을 보인다), agreed = 지금 판에 이미 동의한 항목(안내만).
 * 체크 칸은 미리 체크하지 않는다 (오류로 다시 그릴 때도).
 */
export const ConsentPage = (p: {
  locale: Locale; missing: RequiredConsent[]; agreed: RequiredConsent[]; next: string; error?: RequiredConsent[]; retention: RetentionValues;
}) => {
  const l = p.locale;
  return (
    <section class="wide">
      <h1>{t(l, 'consent.title')}</h1>
      <p>{t(l, p.agreed.length ? 'consent.lead.updated' : 'consent.lead')}</p>
      {p.agreed.length > 0 && <p class="muted">{t(l, 'consent.already').replace('{items}', items(l, p.agreed))}</p>}
      {p.error && p.error.length > 0 && <p class="error">{t(l, 'consent.err.missing').replace('{items}', items(l, p.error))}</p>}
      <form method="post" action="/consent" class="box">
        <input type="hidden" name="next" value={p.next} />
        {p.missing.includes('terms') && (
          <fieldset>
            <legend>{t(l, 'consent.item.terms')}</legend>
            <p class="muted">{t(l, 'consent.terms.what')} <a href="/terms">{t(l, 'consent.read')}</a></p>
            <label class="check"><input type="checkbox" name="terms" value="1" />{t(l, 'consent.terms.label')}</label>
          </fieldset>
        )}
        {p.missing.includes('privacy') && (
          <fieldset>
            <legend>{t(l, 'consent.item.privacy')}</legend>
            <ul class="hint">
              <li>{t(l, 'consent.privacy.items')}</li>
              <li>{t(l, 'consent.privacy.purpose')}</li>
              <li>{tRetention(l, 'consent.privacy.keep', p.retention)}</li>
              <li>{t(l, 'consent.privacy.overseas')}</li>
            </ul>
            <p class="muted"><a href="/privacy">{t(l, 'consent.read')}</a></p>
            <label class="check"><input type="checkbox" name="privacy" value="1" />{t(l, 'consent.privacy.label')}</label>
          </fieldset>
        )}
        <button type="submit">{t(l, 'consent.submit')}</button>
      </form>
      <p class="muted">
        {t(l, 'consent.refuse')} <a href="/my/account">{t(l, 'consent.refuse.account')}</a>
      </p>
      <form method="post" action="/logout" class="inline"><button type="submit" class="link">{t(l, 'nav.logout')}</button></form>
    </section>
  );
};

/** 동의 없이 보낸 POST 에 대한 403 화면. */
export const ConsentRequired = ({ locale }: { locale: Locale }) => (
  <section class="card">
    <h1>{t(locale, 'consent.gate.title')}</h1>
    <p>{t(locale, 'consent.gate.body')}</p>
    <p><a class="button" href="/consent">{t(locale, 'consent.gate.link')}</a></p>
  </section>
);

const ConsentStatus = ({ locale, rows, required }: { locale: Locale; rows: ConsentRow[]; required: RequiredConsentItem[] }) => (
  <ul class="rows">
    {required.map((r) => {
      const valid = rows.filter((x) => x.type === r.type && x.withdrawn_at === null);
      const current = valid.find((x) => x.version === r.version);
      const old = valid.find((x) => x.version !== r.version);
      const text = current ? t(locale, 'acct.consent.agreed').replace('{version}', current.version)
        : old ? t(locale, 'acct.consent.old').replace('{version}', old.version)
        : t(locale, 'acct.consent.none');
      return <li><span>{t(locale, `consent.item.${r.type}`)}</span><span class={current ? '' : 'muted'}>{text}</span></li>;
    })}
  </ul>
);

const BlockText = ({ locale, block }: { locale: Locale; block: DeletionBlock }) => (
  block === 'admin' ? <p class="warn">{t(locale, 'acct.block.admin')}</p>
    : <p class="warn">{t(locale, 'acct.block.owner_with_members')} <a href="/biz/members">{t(locale, 'mem.title')}</a></p>
);

/** 계정 화면: 로그인 이메일, 유형, 동의 내역, 문서, 회원 탈퇴 입구(막히면 이유). */
export const AccountPage = (p: {
  locale: Locale; email: string; role: Role; consents: ConsentRow[]; required: RequiredConsentItem[]; blocks: DeletionBlock[];
}) => {
  const l = p.locale;
  const needsConsent = p.role !== 'admin' && p.required.some((r) => !p.consents.some((x) => x.type === r.type && x.version === r.version && x.withdrawn_at === null));
  return (
    <section class="wide">
      <h1>{t(l, 'acct.title')}</h1>
      <div class="box">
        <dl class="kv">
          <dt>{t(l, 'acct.email')}</dt><dd>{p.email}</dd>
          <dt>{t(l, 'acct.type')}</dt><dd>{t(l, `acct.role.${p.role}`)}</dd>
        </dl>
      </div>
      <div class="box">
        <h2>{t(l, 'acct.consents')}</h2>
        <ConsentStatus locale={l} rows={p.consents} required={p.required} />
        {p.role === 'admin' && <p class="muted">{t(l, 'acct.consent.admin')}</p>}
        {needsConsent && <p><a href="/consent">{t(l, 'acct.consent.go')}</a></p>}
        <DocLinks locale={l} />
      </div>
      <div class="box">
        <h2>{t(l, 'acct.delete.title')}</h2>
        {p.blocks.length > 0 ? p.blocks.map((b) => <BlockText locale={l} block={b} />) : (
          <>
            <p>{t(l, 'acct.delete.lead')}</p>
            <p><a class="danger" href="/my/account/delete">{t(l, 'acct.delete.go')}</a></p>
          </>
        )}
      </div>
    </section>
  );
};

/** 탈퇴 확인 화면. 본인 이메일을 그대로 입력해야 한다. */
export const DeleteConfirm = (p: { locale: Locale; role: Role; error?: boolean }) => {
  const l = p.locale;
  const list = p.role === 'seeker' ? ['del.seeker.1', 'del.seeker.2'] : ['del.company.1', 'del.company.2', 'del.company.3'];
  return (
    <section class="wide">
      <h1>{t(l, 'del.title')}</h1>
      <div class="box">
        <p>{t(l, 'del.lead')}</p>
        <ul>
          {[...list, 'del.all.1', 'del.all.2', 'del.all.3'].map((k) => <li>{t(l, k)}</li>)}
        </ul>
        <p class="muted">{t(l, 'del.policy')} <a href="/privacy">{t(l, 'footer.privacy')}</a></p>
      </div>
      {p.error && <p class="error">{t(l, 'del.err.confirm')}</p>}
      <form method="post" action="/my/account/delete" class="box">
        <label>{t(l, 'del.confirm.label')}
          <input type="email" name="confirm" required autocomplete="off" maxlength={254} />
        </label>
        <div class="actions">
          <button type="submit" class="secondary">{t(l, 'del.submit')}</button>
          <a href="/my/account">{t(l, 'del.cancel')}</a>
        </div>
      </form>
    </section>
  );
};
