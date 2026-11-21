// 기업 담당자 화면(/biz)과 공개 기업 화면(/companies). 모든 값은 JSX 로 출력한다 (자동 이스케이프).
import type { Locale } from '../env';
import {
  COMPANY_DOC_TYPES, ENTITY_TYPES, ENTRY_STAGES, FIELD_MAX, fmtBizNo, fmtDate, isHttpUrl,
  type CompanyField, type CompanyInput, type EntityType, type FieldError, type VerifyStatus,
} from '../lib/company';
import { t } from '../lib/i18n';
import type { VerifyBlock } from '../lib/rules';
import type { CompanyRow } from '../db/companies';

// ── 공통 조각

export const StatusBadge = ({ locale, status }: { locale: Locale; status: VerifyStatus }) => (
  <span class={`badge s-${status}`}>{t(locale, `co.status.${status}`)}</span>
);

export const blockText = (locale: Locale, b: VerifyBlock, entity: EntityType): string =>
  t(locale, b === 'no_document' ? `co.block.no_document.${entity}` : `co.block.${b}`);

export const FieldErrors = ({ locale, errors }: { locale: Locale; errors: FieldError[] }) =>
  errors.length ? (
    <ul class="error">
      {errors.map((e) => <li>{t(locale, `co.f.${e.field}`)}: {t(locale, `co.err.${e.code}`)}</li>)}
    </ul>
  ) : null;

/** 처리 결과 한 줄. key 는 locales 의 키(호출부가 정해진 값만 넘긴다). */
export const Flash = ({ locale, ok, error }: { locale: Locale; ok?: string; error?: string }) => (
  <>
    {ok && <p class="ok">{t(locale, ok)}</p>}
    {error && <p class="error">{t(locale, error)}</p>}
  </>
);

/** 메시지만 있는 화면 (거부·오류). */
export const Notice = ({ locale, textKey, back = '/biz' }: { locale: Locale; textKey: string; back?: string }) => (
  <section class="card">
    <h1>{t(locale, 'biz.title')}</h1>
    <p>{t(locale, textKey)}</p>
    <p><a href={back}>{t(locale, 'common.back')}</a></p>
  </section>
);

const BizNav = ({ locale }: { locale: Locale }) => (
  <p class="crumbs"><a href="/biz">{t(locale, 'biz.title')}</a></p>
);

const label = (locale: Locale, f: CompanyField, required = false) => `${t(locale, `co.f.${f}`)}${required ? ' *' : ''}`;
const stageText = (locale: Locale, s: string | null) => (s ? t(locale, `co.stage.${s}`) : '');

// ── 등록·편집 폼

export interface CompanyFormProps {
  locale: Locale;
  action: string;
  input: CompanyInput;
  errors: FieldError[];
  mode: 'register' | 'edit';
  /** 검증된 기업: 신원 항목을 읽기 전용으로 보여준다. */
  lockedRow?: CompanyRow;
}

export const CompanyForm = ({ locale, action, input, errors, mode, lockedRow }: CompanyFormProps) => (
  <form method="post" action={action}>
    <FieldErrors locale={locale} errors={errors} />
    {lockedRow ? (
      <>
        <dl class="kv">
          <dt>{label(locale, 'name_ko')}</dt><dd>{lockedRow.name_ko}</dd>
          <dt>{label(locale, 'name_zh')}</dt><dd>{lockedRow.name_zh ?? ''}</dd>
          <dt>{label(locale, 'entity_type')}</dt><dd>{t(locale, `co.entity.${lockedRow.entity_type}`)}</dd>
          {lockedRow.entity_type === 'kr_entity' && (<><dt>{label(locale, 'biz_no')}</dt><dd>{fmtBizNo(lockedRow.biz_no)}</dd></>)}
        </dl>
        <p class="muted">{t(locale, 'co.locked_note')}</p>
      </>
    ) : (
      <>
        <label>{label(locale, 'name_ko', true)}
          <input name="name_ko" required maxlength={FIELD_MAX.name_ko} value={input.name_ko} />
        </label>
        <label>{label(locale, 'name_zh')}
          <input name="name_zh" maxlength={FIELD_MAX.name_zh} value={input.name_zh} lang="zh" />
        </label>
        <label>{label(locale, 'entity_type', true)}
          <select name="entity_type" required>
            {ENTITY_TYPES.map((e) => <option value={e} selected={input.entity_type === e}>{t(locale, `co.entity.${e}`)}</option>)}
          </select>
        </label>
        <label>{label(locale, 'biz_no')}
          <input name="biz_no" inputmode="numeric" maxlength={12} placeholder="000-00-00000" value={input.biz_no} />
          <span class="hint">{t(locale, 'co.hint.biz_no')}</span>
        </label>
      </>
    )}
    <label>{label(locale, 'hq_name')}
      <input name="hq_name" maxlength={FIELD_MAX.hq_name} value={input.hq_name} />
    </label>
    <label>{label(locale, 'entry_stage')}
      <select name="entry_stage">
        <option value="">{t(locale, 'common.choose')}</option>
        {ENTRY_STAGES.map((s) => <option value={s} selected={input.entry_stage === s}>{t(locale, `co.stage.${s}`)}</option>)}
      </select>
    </label>
    <label>{label(locale, 'industry')}
      <input name="industry" maxlength={FIELD_MAX.industry} value={input.industry} />
    </label>
    <label>{label(locale, 'website')}
      <input name="website" type="url" maxlength={FIELD_MAX.website} placeholder="https://" value={input.website} />
    </label>
    {mode === 'edit' && (
      <label>{label(locale, 'profile_ko')}
        <textarea name="profile_ko" rows={8} maxlength={FIELD_MAX.profile_ko}>{input.profile_ko}</textarea>
        <span class="hint">{t(locale, 'co.hint.profile_ko')}</span>
      </label>
    )}
    <button type="submit">{t(locale, mode === 'register' ? 'co.register.submit' : 'common.save')}</button>
  </form>
);

// ── /biz 첫 화면

export interface InviteView { id: string; is_hq: number; name_ko: string; name_zh: string | null }

/** 아직 소속이 없는 담당자: 받은 초대 + 기업 등록 폼. */
export const BizStart = (p: { locale: Locale; invites: InviteView[]; input: CompanyInput; errors: FieldError[]; error?: string }) => (
  <section class="wide">
    <h1>{t(p.locale, 'biz.title')}</h1>
    <Flash locale={p.locale} error={p.error} />
    {p.invites.length > 0 && (
      <div class="box">
        <h2>{t(p.locale, 'inv.received')}</h2>
        <ul class="rows">
          {p.invites.map((i) => (
            <li>
              <span>{i.name_ko}{i.name_zh && <span class="muted"> · {i.name_zh}</span>}
                {i.is_hq === 1 && <span class="muted"> ({t(p.locale, 'mem.hq')})</span>}</span>
              <form method="post" action={`/biz/invites/${i.id}/accept`} class="inline">
                <button type="submit">{t(p.locale, 'inv.accept')}</button>
              </form>
            </li>
          ))}
        </ul>
        <p class="muted">{t(p.locale, 'inv.one_company')}</p>
      </div>
    )}
    <div class="box">
      <h2>{t(p.locale, p.invites.length ? 'co.register.other' : 'co.register.title')}</h2>
      <p class="muted">{t(p.locale, 'co.register.lead')}</p>
      <CompanyForm locale={p.locale} action="/biz/company" input={p.input} errors={p.errors} mode="register" />
    </div>
    <p class="muted"><a href="/my/account">{t(p.locale, 'nav.account')}</a></p>
  </section>
);

/** 소속 기업이 있는 담당자의 첫 화면. */
export const BizHome = (p: {
  locale: Locale; company: CompanyRow; isOwner: boolean; blocks: VerifyBlock[]; applicants: { total: number; unread: number }; ok?: string;
}) => {
  const c = p.company;
  return (
    <section class="wide">
      <h1>{c.name_ko}</h1>
      {c.name_zh && <p class="muted sub">{c.name_zh}</p>}
      <Flash locale={p.locale} ok={p.ok} />
      <div class="box">
        <p>{t(p.locale, 'co.status')}: <StatusBadge locale={p.locale} status={c.verify_status} /></p>
        {c.verify_status === 'rejected' && (
          <>
            <p>{t(p.locale, 'co.reject_reason')}</p>
            <p class="pre quote">{c.reject_reason ?? ''}</p>
            <p class="muted">{t(p.locale, 'co.rejected_note')}</p>
          </>
        )}
        {c.verify_status !== 'verified' && (p.blocks.length > 0 ? (
          <>
            <p>{t(p.locale, 'co.todo')}</p>
            <ul>{p.blocks.map((b) => <li>{blockText(p.locale, b, c.entity_type)}</li>)}</ul>
          </>
        ) : c.verify_status === 'pending' && <p class="muted">{t(p.locale, 'co.waiting_review')}</p>)}
        {c.verify_status === 'verified' && (
          <p class="muted">{t(p.locale, 'co.verified_note')} <a href={`/companies/${c.id}`}>{t(p.locale, 'co.public_page')}</a></p>
        )}
      </div>
      <ul class="menu">
        <li><a href="/biz/company/edit">{t(p.locale, 'co.edit.title')}</a></li>
        <li><a href="/biz/company/docs">{t(p.locale, 'doc.title')}</a></li>
        <li><a href="/biz/members">{t(p.locale, 'mem.title')}</a></li>
        <li><a href="/biz/jobs">{t(p.locale, 'job.list.title')}</a></li>
        <li><a href="/my/account">{t(p.locale, 'nav.account')}</a></li>
      </ul>
      <div class="box">
        <h2>{t(p.locale, 'biz.apl.title')}</h2>
        {p.applicants.total === 0 ? <p class="muted">{t(p.locale, 'biz.apl.none')}</p> : (
          <p>
            {p.applicants.unread > 0
              ? <b>{t(p.locale, 'biz.apl.unread').replace('{n}', String(p.applicants.unread))}</b>
              : t(p.locale, 'biz.apl.no_unread')}
            {' · '}{t(p.locale, 'biz.apl.total').replace('{n}', String(p.applicants.total))}
            {' · '}<a href="/biz/jobs">{t(p.locale, 'biz.apl.go')}</a>
          </p>
        )}
      </div>
    </section>
  );
};

export const CompanyEdit = (p: { locale: Locale; company: CompanyRow; input: CompanyInput; errors: FieldError[]; error?: string }) => (
  <section class="wide">
    <BizNav locale={p.locale} />
    <h1>{t(p.locale, 'co.edit.title')}</h1>
    <Flash locale={p.locale} error={p.error} />
    <div class="box">
      <CompanyForm
        locale={p.locale} action="/biz/company/edit" input={p.input} errors={p.errors} mode="edit"
        lockedRow={p.company.verify_status === 'verified' ? p.company : undefined}
      />
    </div>
  </section>
);

// ── 검증 서류

export interface DocView { id: string; doc_type: string; review_status: 'pending' | 'approved' | 'rejected'; created_at: number }

export const DocsPage = (p: { locale: Locale; company: CompanyRow; docs: DocView[]; canUpload: boolean; ok?: string; error?: string }) => (
  <section class="wide">
    <BizNav locale={p.locale} />
    <h1>{t(p.locale, 'doc.title')}</h1>
    <p class="muted">{t(p.locale, `doc.lead.${p.company.entity_type}`)}</p>
    <Flash locale={p.locale} ok={p.ok} error={p.error} />
    <div class="box">
      {p.docs.length === 0 ? <p class="muted">{t(p.locale, 'doc.none')}</p> : (
        <table>
          <thead><tr><th>{t(p.locale, 'doc.type')}</th><th>{t(p.locale, 'doc.date')}</th><th>{t(p.locale, 'doc.review')}</th><th></th></tr></thead>
          <tbody>
            {p.docs.map((d) => (
              <tr>
                <td>{t(p.locale, `doc.type.${d.doc_type}`)}</td>
                <td>{fmtDate(d.created_at)}</td>
                <td>{t(p.locale, `doc.status.${d.review_status}`)}</td>
                <td><a href={`/biz/docs/${d.id}`}>{t(p.locale, 'doc.view')}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    <div class="box">
      <h2>{t(p.locale, 'doc.upload')}</h2>
      {p.canUpload ? (
        <form method="post" action="/biz/company/docs" enctype="multipart/form-data">
          <label>{t(p.locale, 'doc.type')}
            <select name="doc_type" required>
              {COMPANY_DOC_TYPES.map((d) => (
                <option value={d} selected={(p.company.entity_type === 'cn_hq') === (d === 'cn_license')}>{t(p.locale, `doc.type.${d}`)}</option>
              ))}
            </select>
          </label>
          <label>{t(p.locale, 'doc.file')}
            <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" />
            <span class="hint">{t(p.locale, 'doc.hint')}</span>
          </label>
          <button type="submit">{t(p.locale, 'doc.upload.submit')}</button>
        </form>
      ) : <p class="muted">{t(p.locale, 'doc.err.too_many')}</p>}
    </div>
  </section>
);

// ── 담당자

export interface MemberView { user_id: string; email: string; member_role: 'owner' | 'member'; is_hq: number; created_at: number }
export interface PendingInviteView { id: string; email: string; is_hq: number; created_at: number }

export const MembersPage = (p: {
  locale: Locale; company: CompanyRow; me: string; canManage: boolean; seatLeft: boolean;
  members: MemberView[]; invites: PendingInviteView[]; ok?: string; error?: string;
}) => (
  <section class="wide">
    <BizNav locale={p.locale} />
    <h1>{t(p.locale, 'mem.title')}</h1>
    <Flash locale={p.locale} ok={p.ok} error={p.error} />
    <div class="box">
      <table>
        <thead><tr><th>{t(p.locale, 'mem.email')}</th><th>{t(p.locale, 'mem.role')}</th><th>{t(p.locale, 'mem.hq')}</th><th>{t(p.locale, 'mem.joined')}</th><th></th></tr></thead>
        <tbody>
          {p.members.map((m) => (
            <tr>
              <td>{m.email}</td>
              <td>{t(p.locale, `mem.role.${m.member_role}`)}</td>
              <td>{m.is_hq === 1 ? t(p.locale, 'common.yes') : ''}</td>
              <td>{fmtDate(m.created_at)}</td>
              <td>{p.canManage && m.member_role !== 'owner' && m.user_id !== p.me && (
                <form method="post" action={`/biz/members/${m.user_id}/remove`} class="inline">
                  <button type="submit" class="link danger">{t(p.locale, 'mem.remove')}</button>
                </form>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {p.invites.length > 0 && (
      <div class="box">
        <h2>{t(p.locale, 'inv.pending')}</h2>
        <table>
          <thead><tr><th>{t(p.locale, 'mem.email')}</th><th>{t(p.locale, 'mem.hq')}</th><th>{t(p.locale, 'inv.date')}</th><th></th></tr></thead>
          <tbody>
            {p.invites.map((i) => (
              <tr>
                <td>{i.email}</td>
                <td>{i.is_hq === 1 ? t(p.locale, 'common.yes') : ''}</td>
                <td>{fmtDate(i.created_at)}</td>
                <td>{p.canManage && (
                  <form method="post" action={`/biz/invites/${i.id}/cancel`} class="inline">
                    <button type="submit" class="link danger">{t(p.locale, 'inv.cancel')}</button>
                  </form>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    <div class="box">
      <h2>{t(p.locale, 'inv.title')}</h2>
      {!p.canManage ? <p class="muted">{t(p.locale, 'mem.owner_only')}</p>
        : !p.seatLeft ? <p class="muted">{t(p.locale, 'inv.err.limit')}</p>
        : (
          <form method="post" action="/biz/members/invite">
            <label>{t(p.locale, 'mem.email')}
              <input type="email" name="email" required maxlength={254} autocomplete="off" />
            </label>
            {p.company.entity_type === 'cn_hq' ? <p class="muted">{t(p.locale, 'inv.hq_forced')}</p> : (
              <label class="check"><input type="checkbox" name="is_hq" value="1" />{t(p.locale, 'inv.is_hq')}</label>
            )}
            <p class="hint">{t(p.locale, 'inv.hint')}</p>
            <button type="submit">{t(p.locale, 'inv.submit')}</button>
          </form>
        )}
    </div>
  </section>
);

// ── 공개 기업 화면

export interface PublicCompanyRow { id: string; name_ko: string; name_zh: string | null; industry: string | null; entry_stage: string | null }

export const PublicCompanyList = ({ locale, rows }: { locale: Locale; rows: PublicCompanyRow[] }) => (
  <section class="wide">
    <h1>{t(locale, 'pub.title')}</h1>
    <p class="muted">{t(locale, 'pub.lead')}</p>
    {rows.length === 0 ? <p>{t(locale, 'pub.empty')}</p> : (
      <ul class="list">
        {rows.map((r) => (
          <li>
            <a href={`/companies/${r.id}`}>{r.name_ko}</a>
            {r.name_zh && <span class="muted"> · {r.name_zh}</span>}
            <div class="muted">{[r.industry, stageText(locale, r.entry_stage)].filter(Boolean).join(' · ')}</div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

export interface PublicCompanyView {
  name_ko: string; name_zh: string | null; hq_name: string | null; entry_stage: string | null;
  industry: string | null; website: string | null; profile_ko: string | null;
}

export const PublicCompany = ({ locale, c }: { locale: Locale; c: PublicCompanyView }) => (
  <section class="wide">
    <p class="crumbs"><a href="/companies">{t(locale, 'pub.title')}</a></p>
    <h1>{c.name_ko}</h1>
    {c.name_zh && <p class="muted sub">{c.name_zh}</p>}
    <div class="box">
      <h2>{t(locale, 'pub.provided')}</h2>
      <dl class="kv">
        {c.hq_name && (<><dt>{label(locale, 'hq_name')}</dt><dd>{c.hq_name}</dd></>)}
        {c.entry_stage && (<><dt>{label(locale, 'entry_stage')}</dt><dd>{stageText(locale, c.entry_stage)}</dd></>)}
        {c.industry && (<><dt>{label(locale, 'industry')}</dt><dd>{c.industry}</dd></>)}
        {c.website && isHttpUrl(c.website) && (
          <><dt>{label(locale, 'website')}</dt><dd><a href={c.website} rel="noopener noreferrer nofollow">{c.website}</a></dd></>
        )}
      </dl>
      {c.profile_ko ? <p class="pre">{c.profile_ko}</p> : <p class="muted">{t(locale, 'pub.no_profile')}</p>}
      <p class="hint">{t(locale, 'pub.provided_note')}</p>
    </div>
  </section>
);
