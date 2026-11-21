// 관리자: 직무·업계·근무지 선택 항목 관리 (T-06e). 삭제 버튼은 없다 — 사용 종료 ↔ 다시 사용만 있다.
// 관리자가 입력한 이름도 공개 화면에 나가는 믿을 수 없는 글로 보고 JSX 로만 출력한다 (자동 이스케이프).
// 표 한 줄의 입력 칸은 HTML 의 form 속성으로 그 줄의 수정 폼에 묶는다 (클라이언트 자바스크립트 없음).
import type { Locale } from '../env';
import { t } from '../lib/i18n';
import {
  nextSort, OPTION_KINDS, OPTION_LIMITS, type OptionFieldError, type OptionInput, type OptionKind, type OptionRow, type OptionSet,
} from '../lib/options';
import { Flash } from './company';

/** 오류가 난 폼 (입력값을 다시 채운다). */
export interface OptionFormState {
  kind: OptionKind;
  mode: 'add' | 'edit';
  input: OptionInput;
  errors: OptionFieldError[];
}

export interface AdminOptionsProps {
  locale: Locale;
  set: OptionSet;
  /** `${kind}:${code}` → 그 값을 쓰는 공고 수 (모든 상태). */
  counts: Map<string, number>;
  ok?: string;
  error?: string;
  form?: OptionFormState;
}

const KIND_TITLE: Record<OptionKind, string> = {
  role_category: 'job.f.role_category', industry: 'job.f.industry', location: 'job.f.location',
};

const FieldErrors = ({ locale, errors }: { locale: Locale; errors: OptionFieldError[] }) =>
  errors.length ? (
    <ul class="error">{errors.map((e) => <li>{t(locale, `adm.opt.f.${e.field}`)}: {t(locale, `adm.opt.err.${e.code}`)}</li>)}</ul>
  ) : null;

const formId = (kind: OptionKind, code: string) => `opt-${kind}-${code}`;

const Row = ({ locale, kind, row, count, input }: { locale: Locale; kind: OptionKind; row: OptionRow; count: number; input?: OptionInput }) => {
  const l = locale;
  const id = formId(kind, row.code);
  const v = input ?? { code: row.code, label_ko: row.label_ko, label_zh: row.label_zh, sort: String(row.sort) };
  return (
    <tr class={row.active ? '' : 'retired'}>
      <td><code>{row.code}</code></td>
      <td><input form={id} name="label_ko" required maxlength={OPTION_LIMITS.label} value={v.label_ko} lang="ko" aria-label={t(l, 'adm.opt.f.label_ko')} /></td>
      <td><input form={id} name="label_zh" required maxlength={OPTION_LIMITS.label} value={v.label_zh} lang="zh" aria-label={t(l, 'adm.opt.f.label_zh')} /></td>
      <td><input form={id} name="sort" class="opt-sort" required inputmode="numeric" pattern="[0-9]{1,4}" maxlength={4} value={v.sort} aria-label={t(l, 'adm.opt.f.sort')} /></td>
      <td><span class={`badge ${row.active ? 's-verified' : ''}`}>{t(l, row.active ? 'adm.opt.active' : 'adm.opt.retired')}</span></td>
      <td>{count}</td>
      <td class="opt-actions">
        <form method="post" action={`/admin/options/${kind}/${row.code}/edit`} id={id} class="inline">
          <button type="submit" class="plain">{t(l, 'common.save')}</button>
        </form>
        {row.active ? (
          <form method="post" action={`/admin/options/${kind}/${row.code}/retire`} class="inline">
            <button type="submit" class="link danger">{t(l, 'adm.opt.retire')}</button>
          </form>
        ) : (
          <form method="post" action={`/admin/options/${kind}/${row.code}/restore`} class="inline">
            <button type="submit" class="link">{t(l, 'adm.opt.restore')}</button>
          </form>
        )}
      </td>
    </tr>
  );
};

const Section = ({ locale, kind, set, counts, form }: { locale: Locale; kind: OptionKind; set: OptionSet; counts: Map<string, number>; form?: OptionFormState }) => {
  const l = locale;
  const mine = form?.kind === kind ? form : undefined;
  const add = mine?.mode === 'add' ? mine.input : { code: '', label_ko: '', label_zh: '', sort: String(nextSort(set, kind)) };
  const activeN = set.list[kind].filter((r) => r.active).length;
  return (
    <div class="box" id={kind}>
      <h2>{t(l, KIND_TITLE[kind])}</h2>
      <p class="muted">{t(l, 'adm.opt.summary').replace('{n}', String(set.list[kind].length)).replace('{a}', String(activeN))}</p>
      {mine && <FieldErrors locale={l} errors={mine.errors} />}
      <div class="table-wrap"><table class="opt-table">
        <thead><tr>
          <th>{t(l, 'adm.opt.f.code')}</th><th>{t(l, 'adm.opt.f.label_ko')}</th><th>{t(l, 'adm.opt.f.label_zh')}</th>
          <th>{t(l, 'adm.opt.f.sort')}</th><th>{t(l, 'adm.opt.status')}</th><th>{t(l, 'adm.opt.count')}</th><th />
        </tr></thead>
        <tbody>
          {set.list[kind].map((r) => (
            <Row locale={l} kind={kind} row={r} count={counts.get(`${kind}:${r.code}`) ?? 0}
              input={mine?.mode === 'edit' && mine.input.code === r.code ? mine.input : undefined} />
          ))}
        </tbody>
      </table></div>
      <form method="post" action={`/admin/options/${kind}/add`} class="opt-add">
        <h3>{t(l, 'adm.opt.add')}</h3>
        <div class="grid4">
          <label>{t(l, 'adm.opt.f.code')}
            <input name="code" required pattern="[a-z][a-z0-9_]{1,29}" maxlength={30} value={add.code} autocomplete="off" />
          </label>
          <label>{t(l, 'adm.opt.f.label_ko')}
            <input name="label_ko" required maxlength={OPTION_LIMITS.label} value={add.label_ko} lang="ko" />
          </label>
          <label>{t(l, 'adm.opt.f.label_zh')}
            <input name="label_zh" required maxlength={OPTION_LIMITS.label} value={add.label_zh} lang="zh" />
          </label>
          <label>{t(l, 'adm.opt.f.sort')}
            <input name="sort" required inputmode="numeric" pattern="[0-9]{1,4}" maxlength={4} value={add.sort} />
          </label>
        </div>
        <span class="hint">{t(l, 'adm.opt.hint.code')}</span>
        <button type="submit">{t(l, 'adm.opt.add_submit')}</button>
      </form>
    </div>
  );
};

export const AdminOptionsPage = (p: AdminOptionsProps) => {
  const l = p.locale;
  return (
    <section class="wide">
      <p class="crumbs"><a href="/admin">{t(l, 'admin.title')}</a> · <a href="/admin/settings">{t(l, 'adm.set.title')}</a></p>
      <h1>{t(l, 'adm.opt.title')}</h1>
      <Flash locale={l} ok={p.ok} error={p.error} />
      <div class="box">
        <p>{t(l, 'adm.opt.lead')}</p>
        <ul class="hint">
          <li>{t(l, 'adm.opt.hint.immutable')}</li>
          <li>{t(l, 'adm.opt.hint.retire')}</li>
          <li>{t(l, 'adm.opt.hint.no_delete')}</li>
          <li>{t(l, 'adm.opt.hint.last')}</li>
          <li>{t(l, 'adm.opt.hint.cache')}</li>
        </ul>
        <p class="muted">{OPTION_KINDS.map((k, i) => <>{i > 0 && ' · '}<a href={`#${k}`}>{t(l, KIND_TITLE[k])}</a></>)}</p>
      </div>
      {OPTION_KINDS.map((k) => <Section locale={l} kind={k} set={p.set} counts={p.counts} form={p.form} />)}
    </section>
  );
};
