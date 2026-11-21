// 관리자: 직무·업계·근무지 선택 항목 관리 (/admin/options, T-06e). /admin 아래이므로 requireRole('admin') 을 이미 통과했다.
// 할 수 있는 일: 항목 추가, 이름·순서 고치기, 사용 종료 ↔ 다시 사용. **삭제는 없다** (이미 쓰인 값이 공고에 남아 있으므로).
// code·종류는 바꿀 수 없다. 공고를 고치거나 게재하는 기능도 없다 — 이 화면은 선택 목록만 바꾼다.
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import {
  buildOptionSet, isOptionKind, readOptionInput, restoreProblem, retireProblem, validateOptionAdd, validateOptionEdit,
  type OptionFieldError, type OptionInput, type OptionKind, type OptionSet,
} from '../lib/options';
import { render, renderError } from '../render';
import { AdminOptionsPage, type OptionFormState } from '../views/admin-options';
import { countOptionUsage, insertOption, listOptions, setOptionActive, updateOption } from '../db/options';

export const adminOptions = new Hono<AppEnv>();

const OK: Record<string, string> = {
  added: 'adm.opt.ok.added', saved: 'adm.opt.ok.saved', retired: 'adm.opt.ok.retired', restored: 'adm.opt.ok.restored',
};

async function page(c: Context<AppEnv>, msg: { ok?: string; error?: string; form?: OptionFormState; set?: OptionSet }, status: 200 | 400 = 200) {
  const [rows, usage] = await Promise.all([msg.set ? null : listOptions(c.env.DB), countOptionUsage(c.env.DB)]);
  const set = msg.set ?? buildOptionSet(rows ?? []);
  const counts = new Map(usage.map((u) => [`${u.kind}:${u.code}`, u.n]));
  return render(
    c,
    <AdminOptionsPage locale={c.var.locale} set={set} counts={counts} ok={msg.ok} error={msg.error} form={msg.form} />,
    'adm.opt.title',
    status,
  );
}

const loadSet = async (c: Context<AppEnv>) => buildOptionSet(await listOptions(c.env.DB));
const done = (c: Context<AppEnv>, ok: string, kind: OptionKind) => c.redirect(`/admin/options?ok=${ok}#${kind}`);

adminOptions.get('/options', (c) => page(c, { ok: OK[c.req.query('ok') ?? ''] }));

// 추가: code 형식·중복(사용 종료된 항목 포함)·이름·순서를 검사한 뒤 넣는다. 그사이 같은 code 가 생겼으면 중복으로 안내한다.
adminOptions.post('/options/:kind/add', async (c) => {
  const kind = c.req.param('kind');
  if (!isOptionKind(kind)) return renderError(c, 404);
  const input = readOptionInput(await c.req.parseBody());
  const set = await loadSet(c);
  const r = validateOptionAdd(input, set, kind);
  const fail = (errors: OptionFieldError[]) =>
    page(c, { set, error: 'adm.opt.err.form', form: { kind, mode: 'add', input, errors } }, 400);
  if (!r.ok) return fail(r.errors);
  const added = await insertOption(c.env.DB, { kind, ...r.value, userId: c.var.user!.id, ts: now() });
  if (!added) return fail([{ field: 'code', code: 'duplicate' }]);
  return done(c, 'added', kind);
});

// 이름·순서 고치기. code 는 주소에서만 받고 바꾸지 않는다.
adminOptions.post('/options/:kind/:code/edit', async (c) => {
  const kind = c.req.param('kind');
  const code = c.req.param('code');
  if (!isOptionKind(kind)) return renderError(c, 404);
  const set = await loadSet(c);
  if (!set.byCode[kind].has(code)) return renderError(c, 404);
  const input: OptionInput = { ...readOptionInput(await c.req.parseBody()), code };
  const r = validateOptionEdit(input);
  if (!r.ok) return page(c, { set, error: 'adm.opt.err.form', form: { kind, mode: 'edit', input, errors: r.errors } }, 400);
  const saved = await updateOption(c.env.DB, { kind, code, ...r.value, userId: c.var.user!.id, ts: now() });
  if (!saved) return renderError(c, 404);
  return done(c, 'saved', kind);
});

// 사용 종료: 같은 종류의 마지막 사용 중 항목은 끄지 않는다 (먼저 확인하고, UPDATE 의 WHERE 에서 한 번 더 확인한다).
// 그사이 다른 관리자가 바꿔 UPDATE 가 아무 행도 바꾸지 않으면 '화면을 연 뒤 바뀜' 으로 안내하고 최신 목록을 보인다.
adminOptions.post('/options/:kind/:code/retire', async (c) => {
  const kind = c.req.param('kind');
  const code = c.req.param('code');
  if (!isOptionKind(kind)) return renderError(c, 404);
  const set = await loadSet(c);
  const why = retireProblem(set, kind, code);
  if (why === 'unknown') return renderError(c, 404);
  if (why) return page(c, { set, error: `adm.opt.err.${why}` }, 400);
  const changed = await setOptionActive(c.env.DB, { kind, code, active: false, userId: c.var.user!.id, ts: now() });
  if (!changed) return page(c, { error: 'adm.opt.err.changed' }, 400);
  return done(c, 'retired', kind);
});

adminOptions.post('/options/:kind/:code/restore', async (c) => {
  const kind = c.req.param('kind');
  const code = c.req.param('code');
  if (!isOptionKind(kind)) return renderError(c, 404);
  const set = await loadSet(c);
  const why = restoreProblem(set, kind, code);
  if (why === 'unknown') return renderError(c, 404);
  if (why) return page(c, { set, error: `adm.opt.err.${why}` }, 400);
  const changed = await setOptionActive(c.env.DB, { kind, code, active: true, userId: c.var.user!.id, ts: now() });
  if (!changed) return page(c, { error: 'adm.opt.err.changed' }, 400);
  return done(c, 'restored', kind);
});
