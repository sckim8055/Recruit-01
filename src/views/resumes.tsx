// 구직자 이력서 화면 (/my/resumes). 모든 값은 JSX 로 출력한다 (자동 이스케이프).
import type { Locale } from '../env';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import {
  RESUME_CHINESE_LEVELS, RESUME_LIMITS, RESUME_MAX_PER_USER, resumeReadyToApply,
  type ResumeBody, type ResumeField, type ResumeFieldError, type ResumeFileMeta, type ResumeInput,
} from '../lib/resume';
import type { ResumeRow } from '../db/resumes';
import { Flash } from './company';

/** 중국어 수준 이름: 공고와 같은 이름을 쓰되, 'none' 은 구직자 쪽 뜻("할 줄 모름")으로. */
export const levelText = (locale: Locale, lv: string): string =>
  t(locale, lv === 'none' ? 'resume.level.none' : `job.chinese_level.${lv}`);

const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

const Crumbs = ({ locale }: { locale: Locale }) => (
  <p class="crumbs"><a href="/my">{t(locale, 'nav.my')}</a> · <a href="/my/resumes">{t(locale, 'resume.list.title')}</a></p>
);

// ── 목록

export interface ResumeListItem { row: ResumeRow; body: ResumeBody | null }

export const ResumeList = (p: { locale: Locale; items: ResumeListItem[]; canAdd: boolean; ok?: string; error?: string }) => {
  const l = p.locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/my">{t(l, 'nav.my')}</a></p>
      <h1>{t(l, 'resume.list.title')}</h1>
      <p class="sub muted">{t(l, 'resume.list.lead')}</p>
      <Flash locale={l} ok={p.ok} error={p.error} />
      {p.items.length === 0 ? (
        <div class="box">
          <p>{t(l, 'resume.list.empty')}</p>
        </div>
      ) : (
        <ul class="list">
          {p.items.map(({ row, body }) => (
            <li>
              {body ? (
                <>
                  <div>
                    <a href={`/my/resumes/${row.id}/edit`}>{row.title}</a>
                    {row.is_default === 1 && <> <span class="badge s-verified">{t(l, 'resume.default')}</span></>}
                  </div>
                  <div>{body.headline}</div>
                  <div class="facts-line muted">
                    <span>{t(l, 'resume.updated')} {fmtDate(row.updated_at)}</span>
                    <span>{body.file
                      ? <>{t(l, 'resume.f.attachment')}: <a href={`/my/resumes/${row.id}/file`}>{body.file.name}</a></>
                      : t(l, 'resume.no_file')}</span>
                  </div>
                  {!resumeReadyToApply(body) && <p class="warn">{t(l, 'resume.not_ready')}</p>}
                  <div class="actions">
                    <a href={`/my/resumes/${row.id}/edit`}>{t(l, 'resume.action.edit')}</a>
                    {p.canAdd && (
                      <form method="post" action={`/my/resumes/${row.id}/copy`} class="inline">
                        <button type="submit" class="link">{t(l, 'resume.action.copy')}</button>
                      </form>
                    )}
                    {row.is_default !== 1 && (
                      <form method="post" action={`/my/resumes/${row.id}/default`} class="inline">
                        <button type="submit" class="link">{t(l, 'resume.action.default')}</button>
                      </form>
                    )}
                    <a href={`/my/resumes/${row.id}/delete`} class="danger">{t(l, 'resume.action.delete')}</a>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span>{row.title}</span> <span class="badge s-rejected">{t(l, 'resume.unopenable')}</span>
                    {row.is_default === 1 && <> <span class="badge">{t(l, 'resume.default')}</span></>}
                  </div>
                  <p class="muted">{t(l, 'resume.unopenable.note')}</p>
                  <div class="actions">
                    <a href={`/my/resumes/${row.id}/delete`} class="danger">{t(l, 'resume.action.delete')}</a>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class="actions">
        {p.canAdd
          ? <a class="button" href="/my/resumes/new">{t(l, 'resume.action.new')}</a>
          : <><button type="button" disabled>{t(l, 'resume.action.new')}</button>
            <span class="muted">{t(l, 'resume.limit_note').replace('{n}', String(RESUME_MAX_PER_USER))}</span></>}
      </div>
      <p class="muted spaced">{t(l, 'resume.apply_note')}</p>
    </section>
  );
};

// ── 작성·수정 폼

const FIELDS_ORDER: ResumeField[] = ['title', 'name', 'chinese_level', 'years', 'headline', 'contact_email', 'phone', 'desired_role', 'experience_text'];

/** 항목 오류 문구: 길이 초과는 한도를 넣고, 형식 오류는 항목별 안내가 있다. */
function errText(locale: Locale, e: ResumeFieldError): string {
  if (e.code === 'too_long') {
    const n = RESUME_LIMITS[e.field === 'contact_email' ? 'email' : (e.field as Exclude<ResumeField, 'contact_email' | 'chinese_level'>)];
    return t(locale, 'resume.err.too_long').replace('{n}', String(n));
  }
  if (e.code === 'invalid') return t(locale, `resume.err.invalid.${e.field}`);
  return t(locale, 'resume.err.required');
}

const FieldErrors = ({ locale, errors, fileError }: { locale: Locale; errors: ResumeFieldError[]; fileError?: string }) => {
  if (!errors.length && !fileError) return null;
  const sorted = [...errors].sort((a, b) => FIELDS_ORDER.indexOf(a.field) - FIELDS_ORDER.indexOf(b.field));
  return (
    <ul class="error">
      {sorted.map((e) => <li>{t(locale, `resume.f.${e.field}`)}: {errText(locale, e)}</li>)}
      {fileError && <li>{t(locale, 'resume.f.attachment')}: {t(locale, `resume.err.file.${fileError}`)}</li>}
    </ul>
  );
};

export interface ResumeFormProps {
  locale: Locale;
  input: ResumeInput;
  errors: ResumeFieldError[];
  fileError?: 'too_large' | 'bad_type';
  error?: string;
  current?: ResumeFileMeta | null;
  resumeId?: string;
  updatedAt?: number;
}

export const ResumeForm = (p: ResumeFormProps) => {
  const l = p.locale;
  const i = p.input;
  const edit = !!p.resumeId;
  const hasErr = (f: ResumeField) => p.errors.some((e) => e.field === f);
  const lab = (f: ResumeField | 'attachment', required = false) => `${t(l, `resume.f.${f}`)}${required ? ' *' : ''}`;
  const failed = p.errors.length > 0 || !!p.fileError || !!p.error;
  return (
    <section class="wide">
      <Crumbs locale={l} />
      <h1>{t(l, edit ? 'resume.edit.title' : 'resume.new.title')}</h1>
      <p class="sub muted">{t(l, 'resume.form.lead')}</p>
      <Flash locale={l} error={p.error} />
      <FieldErrors locale={l} errors={p.errors} fileError={p.fileError} />
      {failed && <p class="warn">{t(l, 'resume.err.reselect_file')}</p>}
      <form method="post" action={edit ? `/my/resumes/${p.resumeId}/edit` : '/my/resumes/new'} enctype="multipart/form-data" class="box">
        {edit && <input type="hidden" name="updated_at" value={String(p.updatedAt ?? '')} />}
        <label>{lab('title', true)}
          <input name="title" required maxlength={RESUME_LIMITS.title} value={i.title} aria-invalid={hasErr('title') ? 'true' : undefined} />
          <span class="hint">{t(l, 'resume.hint.title')}</span>
        </label>
        <div class="grid2">
          <label>{lab('name', true)}
            <input name="name" required maxlength={RESUME_LIMITS.name} value={i.name} autocomplete="name" aria-invalid={hasErr('name') ? 'true' : undefined} />
          </label>
          <label>{lab('contact_email', true)}
            <input name="contact_email" type="email" required maxlength={RESUME_LIMITS.email} value={i.contact_email} autocomplete="email"
              aria-invalid={hasErr('contact_email') ? 'true' : undefined} />
          </label>
          <label>{lab('chinese_level', true)}
            <select name="chinese_level" required aria-invalid={hasErr('chinese_level') ? 'true' : undefined}>
              <option value="">{t(l, 'common.choose')}</option>
              {RESUME_CHINESE_LEVELS.map((lv) => <option value={lv} selected={i.chinese_level === lv}>{levelText(l, lv)}</option>)}
            </select>
          </label>
          <label>{lab('years', true)}
            <input name="years" type="number" inputmode="numeric" min={0} max={RESUME_LIMITS.years} step={1} required value={i.years}
              aria-invalid={hasErr('years') ? 'true' : undefined} />
            <span class="hint">{t(l, 'resume.hint.years')}</span>
          </label>
        </div>
        <label>{lab('headline', true)}
          <input name="headline" required maxlength={RESUME_LIMITS.headline} value={i.headline} aria-invalid={hasErr('headline') ? 'true' : undefined} />
          <span class="hint">{t(l, 'resume.hint.headline')}</span>
        </label>
        <div class="grid2">
          <label>{lab('phone')}
            <input name="phone" type="tel" maxlength={RESUME_LIMITS.phone} value={i.phone} autocomplete="tel" aria-invalid={hasErr('phone') ? 'true' : undefined} />
          </label>
          <label>{lab('desired_role')}
            <input name="desired_role" maxlength={RESUME_LIMITS.desired_role} value={i.desired_role} />
          </label>
        </div>
        <label>{lab('experience_text')}
          <textarea name="experience_text" rows={8} maxlength={RESUME_LIMITS.experience_text}>{i.experience_text}</textarea>
          <span class="hint">{t(l, 'resume.hint.experience_text')}</span>
        </label>
        <fieldset>
          <legend>{lab('attachment')}</legend>
          {edit && p.current && (
            <>
              <p>{t(l, 'resume.file.current')}: <a href={`/my/resumes/${p.resumeId}/file`}>{p.current.name}</a>
                <span class="muted"> ({fmtSize(p.current.size)})</span></p>
              <label class="check"><input type="checkbox" name="remove_file" value="1" />{t(l, 'resume.file.remove')}</label>
            </>
          )}
          <label>{t(l, edit && p.current ? 'resume.file.replace' : 'resume.file.choose')}
            <input type="file" name="attachment"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
            <span class="hint">{t(l, 'resume.hint.attachment')}</span>
          </label>
        </fieldset>
        <div class="actions">
          <button type="submit">{t(l, 'common.save')}</button>
          <a href="/my/resumes">{t(l, 'common.cancel')}</a>
        </div>
      </form>
    </section>
  );
};

// ── 삭제 확인

export const ResumeDeleteConfirm = ({ locale, id, title }: { locale: Locale; id: string; title: string }) => (
  <section class="card">
    <h1>{t(locale, 'resume.delete.title')}</h1>
    <p><b>{title}</b></p>
    <p>{t(locale, 'resume.delete.lead')}</p>
    <p class="muted">{t(locale, 'resume.delete.note')}</p>
    <form method="post" action={`/my/resumes/${id}/delete`}>
      <div class="actions">
        <button type="submit" class="secondary">{t(locale, 'resume.delete.submit')}</button>
        <a href="/my/resumes">{t(locale, 'common.cancel')}</a>
      </div>
    </form>
  </section>
);

/** 요청 본문이 너무 커서 읽지 않은 경우. 입력값을 받지 못했으므로 다시 그릴 수 없다. */
export const ResumeTooLarge = ({ locale, back }: { locale: Locale; back: string }) => (
  <section class="card">
    <h1>{t(locale, 'resume.err.body_too_large.title')}</h1>
    <p>{t(locale, 'resume.err.body_too_large')}</p>
    <p><a href={back}>{t(locale, 'common.back')}</a></p>
  </section>
);
