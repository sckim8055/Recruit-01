// 관리자 기업 검증 화면. 관리자는 기업 정보를 고칠 수 없고 승인·반려·승인 취소만 한다.
import type { Locale } from '../env';
import { REJECT_REASON_MAX, fmtBizNo, fmtDate, type EntityType, type VerifyStatus } from '../lib/company';
import { t } from '../lib/i18n';
import type { VerifyBlock } from '../lib/rules';
import type { CompanyRow } from '../db/companies';
import { Flash, StatusBadge, blockText, type DocView, type MemberView } from './company';

export interface AdminCompanyListRow {
  id: string; name_ko: string; entity_type: EntityType; verify_status: VerifyStatus; created_at: number; docs: number;
}

export const AdminCompanyList = ({ locale, rows }: { locale: Locale; rows: AdminCompanyListRow[] }) => (
  <section class="wide">
    <p class="crumbs"><a href="/admin">{t(locale, 'admin.title')}</a></p>
    <h1>{t(locale, 'adm.co.title')}</h1>
    {rows.length === 0 ? <p class="muted">{t(locale, 'adm.co.empty')}</p> : (
      <div class="box">
        <table>
          <thead><tr>
            <th>{t(locale, 'co.f.name_ko')}</th><th>{t(locale, 'co.f.entity_type')}</th><th>{t(locale, 'co.status')}</th>
            <th>{t(locale, 'adm.co.created')}</th><th>{t(locale, 'adm.co.docs')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td><a href={`/admin/companies/${r.id}`}>{r.name_ko}</a></td>
                <td>{t(locale, `co.entity.${r.entity_type}`)}</td>
                <td><StatusBadge locale={locale} status={r.verify_status} /></td>
                <td>{fmtDate(r.created_at)}</td>
                <td>{r.docs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

export interface AdminCompanyDetailProps {
  locale: Locale;
  company: CompanyRow;
  members: Pick<MemberView, 'email' | 'member_role' | 'is_hq' | 'created_at'>[];
  docs: DocView[];
  blocks: VerifyBlock[];
  snapshot: string;
  ok?: string;
  error?: string;
}

export const AdminCompanyDetail = (p: AdminCompanyDetailProps) => {
  const c = p.company;
  const l = p.locale;
  const pending = c.verify_status === 'pending';
  const verified = c.verify_status === 'verified';
  const reasonField = (labelKey: string) => (
    <>
      <label>{t(l, labelKey)}
        <textarea name="reason" rows={3} required maxlength={REJECT_REASON_MAX}></textarea>
        <span class="hint">{t(l, 'adm.co.reason_hint')}</span>
      </label>
      <label class="check"><input type="checkbox" name="reject_docs" value="1" />{t(l, 'adm.co.reject_docs')}</label>
      <p class="hint">{t(l, 'adm.co.reject_docs_hint')}</p>
    </>
  );
  const row = (k: string, v: unknown) => (<><dt>{t(l, k)}</dt><dd>{v as string}</dd></>);
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin/companies">{t(l, 'adm.co.title')}</a></p>
      <h1>{c.name_ko}</h1>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <div class="box">
        <dl class="kv">
          {row('co.status', <StatusBadge locale={l} status={c.verify_status} />)}
          {row('co.f.name_ko', c.name_ko)}
          {row('co.f.name_zh', c.name_zh ?? '')}
          {row('co.f.entity_type', t(l, `co.entity.${c.entity_type}`))}
          {row('co.f.biz_no', fmtBizNo(c.biz_no))}
          {row('co.f.hq_name', c.hq_name ?? '')}
          {row('co.f.entry_stage', c.entry_stage ? t(l, `co.stage.${c.entry_stage}`) : '')}
          {row('co.f.industry', c.industry ?? '')}
          {/* 관리자 화면에서는 기업이 적은 주소를 링크로 만들지 않는다 */}
          {row('co.f.website', c.website ?? '')}
          {row('adm.co.created', fmtDate(c.created_at))}
          {c.verified_at && row('adm.co.verified_at', fmtDate(c.verified_at))}
          {c.reject_reason && row('co.reject_reason', <span class="pre">{c.reject_reason}</span>)}
        </dl>
        <h2>{t(l, 'co.f.profile_ko')}</h2>
        {c.profile_ko ? <p class="pre">{c.profile_ko}</p> : <p class="muted">{t(l, 'pub.no_profile')}</p>}
      </div>

      <div class="box">
        <h2>{t(l, 'mem.title')}</h2>
        <table>
          <thead><tr><th>{t(l, 'mem.email')}</th><th>{t(l, 'mem.role')}</th><th>{t(l, 'mem.hq')}</th><th>{t(l, 'mem.joined')}</th></tr></thead>
          <tbody>
            {p.members.map((m) => (
              <tr>
                <td>{m.email}</td><td>{t(l, `mem.role.${m.member_role}`)}</td>
                <td>{m.is_hq === 1 ? t(l, 'common.yes') : ''}</td><td>{fmtDate(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="box">
        <h2>{t(l, 'doc.title')}</h2>
        {p.docs.length === 0 ? <p class="muted">{t(l, 'doc.none')}</p> : (
          <table>
            <thead><tr><th>{t(l, 'doc.type')}</th><th>{t(l, 'doc.date')}</th><th>{t(l, 'doc.review')}</th><th></th></tr></thead>
            <tbody>
              {p.docs.map((d) => (
                <tr>
                  <td>{t(l, `doc.type.${d.doc_type}`)}</td><td>{fmtDate(d.created_at)}</td>
                  <td>{t(l, `doc.status.${d.review_status}`)}</td>
                  <td><a href={`/admin/docs/${d.id}`}>{t(l, 'doc.view')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="hint">{t(l, 'adm.co.doc_log_note')}</p>
      </div>

      <div class="box">
        <h2>{t(l, 'adm.co.decide')}</h2>
        <p class="muted">{t(l, 'adm.co.manual_note')}</p>
        {verified ? (
          <form method="post" action={`/admin/companies/${c.id}/revoke`}>
            <p>{t(l, 'adm.co.revoke_note')}</p>
            {reasonField('adm.co.revoke_reason')}
            <button type="submit" class="secondary">{t(l, 'adm.co.revoke')}</button>
          </form>
        ) : !pending ? <p class="muted">{t(l, 'adm.err.not_pending')}</p> : (
          <>
            {p.blocks.length > 0 && (
              <>
                <p>{t(l, 'adm.co.blocked')}</p>
                <ul class="error">{p.blocks.map((b) => <li>{blockText(l, b, c.entity_type)}</li>)}</ul>
              </>
            )}
            <form method="post" action={`/admin/companies/${c.id}/verify`}>
              <input type="hidden" name="action" value="approve" />
              <input type="hidden" name="seen" value={p.snapshot} />
              <button type="submit" disabled={p.blocks.length > 0}>{t(l, 'adm.co.approve')}</button>
            </form>
            <form method="post" action={`/admin/companies/${c.id}/verify`} class="spaced">
              <input type="hidden" name="action" value="reject" />
              {reasonField('adm.co.reason')}
              <button type="submit" class="secondary">{t(l, 'adm.co.reject')}</button>
            </form>
          </>
        )}
      </div>
    </section>
  );
};
