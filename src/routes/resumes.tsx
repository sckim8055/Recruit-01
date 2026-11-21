// 구직자 이력서 화면 (/my/resumes...). 구직자 본인만 쓴다 — 기업·헤드헌터·관리자는 403 (관리자 열람 화면은 이 작업에 없다).
// - 행은 항상 로그인 사용자의 id 로 읽는다(db/resumes.ts 의 모든 문장이 user_id 조건). 남의 id 는 없는 것과 같게 404.
// - 권한: lib/authz.canEditResume / canViewResume (내려받기는 serveResumeFile 이 확인·기록한다).
// - 내용 검사·암호화는 lib/resume.ts, 파일 검사·암호화·R2 는 lib/resume-files.ts 만 쓴다. 여기서 다시 만들지 않는다.
// - 개인정보 보호: 이력서 내용·이름·이메일·파일명·복호화한 값을 console 에 남기지 않는다. 주소·리다이렉트에는 ?ok= 같은 정해진 값만.
// - 모든 응답은 Cache-Control: private, no-store.
import { Hono, type Context } from 'hono';
import { now, type AppEnv, type SessionUser } from '../env';
import { loadActor } from '../lib/actor';
import { requireRole } from '../lib/auth';
import { canEditResume } from '../lib/authz';
import { importEncKey } from '../lib/crypto';
import { t } from '../lib/i18n';
import {
  EMPTY_RESUME_INPUT, RESUME_MAX_PER_USER, copyTitle, inputFromResume, openResume, readResumeForm, sealResume, validateResume,
  type ResumeBody, type ResumeFieldError, type ResumeFileMeta, type ResumeInput,
} from '../lib/resume';
import { RESUME_FILE_MAX_BYTES, checkResumeUpload, copyResumeFile, deleteResumeFile, putResumeFile, serveResumeFile } from '../lib/resume-files';
import { render, renderError } from '../render';
import { ResumeDeleteConfirm, ResumeForm, ResumeList, ResumeTooLarge, type ResumeListItem } from '../views/resumes';
import { countResumes, deleteResume, getResume, insertResume, listResumes, setDefaultResume, updateResume, type ResumeRow } from '../db/resumes';

export const resumes = new Hono<AppEnv>();

const NO_STORE = 'private, no-store';

// 캐시 금지 머리글은 권한 검사보다 먼저 건다 (403·로그인 리다이렉트에도 붙게).
resumes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', NO_STORE);
});
resumes.use('*', requireRole('seeker'));

/**
 * 요청 본문이 이 크기를 넘으면 읽지 않고 거절한다 (파일 한도 5MB + 폼 항목·multipart 경계 여유 1MB).
 * content-length 가 없는 요청(chunked)은 parseBody 가 읽은 뒤 checkResumeUpload 의 5MB 검사에 맡긴다.
 */
export const RESUME_BODY_MAX_BYTES = RESUME_FILE_MAX_BYTES + 1024 * 1024;

const tooLarge = (c: Context<AppEnv>): boolean => {
  const n = Number(c.req.header('content-length') ?? '');
  return Number.isFinite(n) && n > RESUME_BODY_MAX_BYTES;
};

/** 오류는 종류만 남긴다 (메시지에도 내용이 섞일 수 있으므로 정해진 문자열만). */
const logFail = (what: string) => console.error(`resume: ${what} failed`);

const key = (c: Context<AppEnv>) => importEncKey(c.env.ENC_KEY);

/** 내 이력서 한 개 (남의 것·없는 것은 null). */
const loadRow = (c: Context<AppEnv>, user: SessionUser) => getResume(c.env.DB, c.req.param('id') ?? '', user.id);

/** 저장된 이력서를 연다. 열 수 없으면(키가 다름·손상) null — 예외 내용은 내보내지 않는다. */
async function tryOpen(k: CryptoKey, row: ResumeRow): Promise<ResumeBody | null> {
  try {
    return await openResume(k, row.body);
  } catch {
    return null;
  }
}

/** 내 이력서를 열어서 돌려준다. 없거나·고칠 수 없거나·열 수 없으면 null (호출부는 404). */
async function loadOwn(c: Context<AppEnv>): Promise<{ user: SessionUser; row: ResumeRow; body: ResumeBody } | null> {
  const user = c.var.user!;
  const row = await loadRow(c, user);
  if (!row) return null;
  const actor = await loadActor(c.env, user);
  if (!canEditResume(actor, row)) return null;
  const body = await tryOpen(await key(c), row);
  return body ? { user, row, body } : null;
}

// ── 목록

const LIST_OK: Record<string, string> = {
  created: 'resume.ok.created', saved: 'resume.ok.saved', copied: 'resume.ok.copied', copied_nofile: 'resume.ok.copied_nofile',
  default: 'resume.ok.default', deleted: 'resume.ok.deleted',
};
const LIST_ERR: Record<string, string> = { limit: 'resume.err.limit' };

resumes.get('/', async (c) => {
  const user = c.var.user!;
  const rows = await listResumes(c.env.DB, user.id);
  const k = await key(c);
  const items: ResumeListItem[] = [];
  for (const row of rows) items.push({ row, body: await tryOpen(k, row) });
  return render(
    c,
    <ResumeList locale={c.var.locale} items={items} canAdd={rows.length < RESUME_MAX_PER_USER}
      ok={LIST_OK[c.req.query('ok') ?? '']} error={LIST_ERR[c.req.query('err') ?? '']} />,
    'resume.list.title',
  );
});

// ── 폼 공통

interface FormState {
  input: ResumeInput;
  errors: ResumeFieldError[];
  fileError?: 'too_large' | 'bad_type';
  error?: string;            // 화면 위 한 줄 (locales 키)
  current?: ResumeFileMeta | null; // 편집: 지금 저장된 첨부파일
  resumeId?: string;
  updatedAt?: number;
}

const formPage = (c: Context<AppEnv>, s: FormState, status: 200 | 400 = 200) =>
  render(c, <ResumeForm locale={c.var.locale} {...s} />, s.resumeId ? 'resume.edit.title' : 'resume.new.title', status);

/** 폼에서 첨부파일 칸을 읽는다: 새 파일(검사 통과) / 고르지 않음 / 오류. */
type FileChoice = { kind: 'none' } | { kind: 'new'; bytes: Uint8Array; meta: ResumeFileMeta } | { kind: 'error'; why: 'too_large' | 'bad_type' };
async function readFile(f: Record<string, unknown>): Promise<FileChoice> {
  const up = await checkResumeUpload(f.attachment);
  if (up.ok) return { kind: 'new', bytes: up.bytes, meta: up.meta };
  return up.why === 'empty' ? { kind: 'none' } : { kind: 'error', why: up.why };
}

// ── 새 이력서

resumes.get('/new', async (c) => {
  const user = c.var.user!;
  if (await countResumes(c.env.DB, user.id) >= RESUME_MAX_PER_USER) return c.redirect('/my/resumes?err=limit');
  return formPage(c, { input: { ...EMPTY_RESUME_INPUT, contact_email: user.email }, errors: [] });
});

resumes.post('/new', async (c) => {
  const user = c.var.user!;
  if (tooLarge(c)) return render(c, <ResumeTooLarge locale={c.var.locale} back="/my/resumes/new" />, 'resume.new.title', 413);
  // 한도는 insertResume 가 한 문장으로 다시 지킨다. 여기서는 파일을 올리기 전에 미리 알려 주려는 것.
  if (await countResumes(c.env.DB, user.id) >= RESUME_MAX_PER_USER) return c.redirect('/my/resumes?err=limit');
  const actor = await loadActor(c.env, user);
  if (!canEditResume(actor, { user_id: user.id })) return renderError(c, 403);

  const f = await c.req.parseBody();
  const input = readResumeForm(f);
  const v = validateResume(input);
  const file = await readFile(f);
  if (!v.ok || file.kind === 'error') {
    return formPage(c, { input, errors: v.ok ? [] : v.errors, fileError: file.kind === 'error' ? file.why : undefined }, 400);
  }

  // 정리 규칙: 새 파일을 R2 에 먼저 올린다 → DB 에 넣는다. DB 쓰기가 실패하거나(예외) 한도에 걸리면(false)
  // 방금 올린 파일을 지운다. 그래야 어느 행도 가리키지 않는 파일이 남지 않는다.
  const newKey = file.kind === 'new' ? await putResumeFile(c.env, file.bytes) : null;
  let inserted = false;
  try {
    const sealed = await sealResume(await key(c), { v: 1, ...v.fields, file: file.kind === 'new' ? file.meta : null });
    inserted = await insertResume(c.env.DB, { id: crypto.randomUUID(), userId: user.id, title: v.title, body: sealed, fileKey: newKey, ts: now() }, RESUME_MAX_PER_USER);
  } catch (e) {
    await cleanup(c, newKey);
    throw e;
  }
  if (!inserted) {
    await cleanup(c, newKey);
    return c.redirect('/my/resumes?err=limit');
  }
  return c.redirect('/my/resumes?ok=created');
});

/**
 * R2 파일을 지운다 (방금 올렸지만 어느 행도 가리키지 않게 된 파일, 또는 행이 더 이상 가리키지 않는 예전 파일).
 * 지우기가 실패해도 요청은 실패시키지 않는다 — 고아 파일이 남고, T-12 정리 작업이 치운다.
 */
async function cleanup(c: Context<AppEnv>, r2Key: string | null): Promise<void> {
  if (!r2Key) return;
  try {
    await deleteResumeFile(c.env, r2Key);
  } catch {
    logFail('file cleanup');
  }
}

// ── 수정

resumes.get('/:id/edit', async (c) => {
  const x = await loadOwn(c);
  if (!x) return renderError(c, 404);
  return formPage(c, {
    input: inputFromResume(x.row.title, x.body), errors: [], current: x.body.file, resumeId: x.row.id, updatedAt: x.row.updated_at,
  });
});

resumes.post('/:id/edit', async (c) => {
  if (tooLarge(c)) {
    return render(c, <ResumeTooLarge locale={c.var.locale} back={`/my/resumes/${encodeURIComponent(c.req.param('id'))}/edit`} />, 'resume.edit.title', 413);
  }
  const x = await loadOwn(c);
  if (!x) return renderError(c, 404);
  const { user, row, body: old } = x;

  const f = await c.req.parseBody();
  const input = readResumeForm(f);
  const expected = /^\d{1,12}$/.test(String(f.updated_at ?? '')) ? Number(f.updated_at) : -1;
  const v = validateResume(input);
  const file = await readFile(f);
  const removeFile = f.remove_file === '1';
  const base = { resumeId: row.id, current: old.file, updatedAt: expected };
  if (!v.ok || file.kind === 'error') {
    return formPage(c, { ...base, input, errors: v.ok ? [] : v.errors, fileError: file.kind === 'error' ? file.why : undefined }, 400);
  }

  // 첨부파일: 새 파일이 있으면 바꾸고, 없으면 "삭제" 체크에 따라 지우거나 그대로 둔다.
  const newKey = file.kind === 'new' ? await putResumeFile(c.env, file.bytes) : null;
  const fileMeta = file.kind === 'new' ? file.meta : removeFile ? null : old.file;
  const fileKey = file.kind === 'new' ? newKey : removeFile ? null : row.file_r2_key;
  // updated_at 이 항상 커지게 한다 (같은 초에 두 번 저장해도 다음 비교가 맞게).
  const ts = Math.max(now(), row.updated_at + 1);

  let saved = false;
  try {
    const sealed = await sealResume(await key(c), { v: 1, ...v.fields, file: fileMeta });
    saved = await updateResume(c.env.DB, { id: row.id, userId: user.id, title: v.title, body: sealed, fileKey, ts, expectedUpdatedAt: expected });
  } catch (e) {
    // DB 쓰기 실패: 행은 여전히 예전 파일을 가리킨다 → 새 파일만 지우고, 예전 파일은 건드리지 않는다.
    await cleanup(c, newKey);
    throw e;
  }
  if (!saved) {
    // 다른 창에서 먼저 고쳤거나 지워졌다: 새 파일만 지운다(예전 파일은 여전히 행이 가리킨다).
    await cleanup(c, newKey);
    const fresh = await loadOwn(c);
    if (!fresh) return renderError(c, 404);
    // 입력값은 그대로 두고, 지금 저장된 첨부파일과 버전을 보여준다. 다시 저장하면 다른 창의 변경을 덮어쓴다(안내 문구).
    return formPage(c, {
      input, errors: [], error: 'resume.err.stale', resumeId: row.id, current: fresh.body.file, updatedAt: fresh.row.updated_at,
    }, 400);
  }
  // DB 가 새 파일(또는 없음)을 가리키게 된 뒤에만 예전 파일을 지운다. 순서를 바꾸면 실패 시 행이 없는 파일을 가리킨다.
  if (row.file_r2_key && row.file_r2_key !== fileKey) await cleanup(c, row.file_r2_key);
  return c.redirect('/my/resumes?ok=saved');
});

// ── 복사

resumes.post('/:id/copy', async (c) => {
  const x = await loadOwn(c);
  if (!x) return renderError(c, 404);
  const { user, row, body } = x;
  if (await countResumes(c.env.DB, user.id) >= RESUME_MAX_PER_USER) return c.redirect('/my/resumes?err=limit');

  // 첨부파일은 이력서마다 따로 가진다: 풀어서 새 키로 다시 암호화해 둔다(copyResumeFile).
  // 원본 파일이 없거나 열 수 없으면 첨부 없이 복사하고 그 사실을 알려 준다.
  let newKey: string | null = null;
  if (row.file_r2_key && body.file) {
    try {
      newKey = await copyResumeFile(c.env, row.file_r2_key);
    } catch {
      logFail('file copy');
      newKey = null;
    }
  }
  const lostFile = !!(row.file_r2_key && body.file) && !newKey;
  let inserted = false;
  try {
    const sealed = await sealResume(await key(c), { ...body, file: newKey ? body.file : null });
    inserted = await insertResume(c.env.DB, {
      id: crypto.randomUUID(), userId: user.id, title: copyTitle(row.title, t(c.var.locale, 'resume.copy_suffix')), body: sealed, fileKey: newKey, ts: now(),
    }, RESUME_MAX_PER_USER);
  } catch (e) {
    await cleanup(c, newKey);
    throw e;
  }
  if (!inserted) {
    await cleanup(c, newKey);
    return c.redirect('/my/resumes?err=limit');
  }
  return c.redirect(`/my/resumes?ok=${lostFile ? 'copied_nofile' : 'copied'}`);
});

// ── 대표 지정

resumes.post('/:id/default', async (c) => {
  const user = c.var.user!;
  const ok = await setDefaultResume(c.env.DB, c.req.param('id'), user.id);
  if (!ok) return renderError(c, 404);
  return c.redirect('/my/resumes?ok=default');
});

// ── 삭제 (자바스크립트 없이 확인 화면 → POST). 열 수 없는 이력서도 지울 수 있다(제목만 쓴다).

resumes.get('/:id/delete', async (c) => {
  const row = await loadRow(c, c.var.user!);
  if (!row) return renderError(c, 404);
  return render(c, <ResumeDeleteConfirm locale={c.var.locale} id={row.id} title={row.title} />, 'resume.delete.title');
});

resumes.post('/:id/delete', async (c) => {
  const user = c.var.user!;
  const row = await loadRow(c, user);
  if (!row) return renderError(c, 404);
  const actor = await loadActor(c.env, user);
  if (!canEditResume(actor, row)) return renderError(c, 404);
  const deleted = await deleteResume(c.env.DB, row.id, user.id);
  if (!deleted) return renderError(c, 404);
  // 행이 지워진 뒤에 파일을 지운다 (지우기가 실패하면 고아 파일 → T-12 정리 작업).
  await cleanup(c, row.file_r2_key);
  return c.redirect('/my/resumes?ok=deleted');
});

// ── 첨부파일 내려받기: 권한 확인 → 열람 기록 → 복호화 → 전송은 serveResumeFile 만 한다. 미리보기 없음.

resumes.get('/:id/file', async (c) => {
  const user = c.var.user!;
  const row = await loadRow(c, user);
  if (!row) return renderError(c, 404);
  const body = await tryOpen(await key(c), row);
  if (!body) return renderError(c, 404);
  const actor = await loadActor(c.env, user);
  const res = await serveResumeFile(c.env, actor, row, body.file, null);
  return res ?? renderError(c, 404);
});
