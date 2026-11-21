// 동의 화면(/consent)과 계정·회원 탈퇴(/my/account*) (T-11).
// - 동의 판단은 lib/consent, 기록은 db/consents.insertConsents 뿐이다. 동의는 이 파일의 POST /consent 에서만 남긴다.
// - 탈퇴 판단·삭제는 lib/account (deletionBlocksFor · deleteAccount · confirmMatches) 만 쓴다.
// - 모든 응답(로그인 리다이렉트 포함)은 private, no-store.
import { Hono } from 'hono';
import { now, type AppEnv } from '../env';
import { confirmMatches, deleteAccount, deletionBlocksFor, type DeletionBlock } from '../lib/account';
import { logout, requireRole } from '../lib/auth';
import { missingConsents, readConsentForm, REQUIRED_CONSENT_TYPES, requiredConsents, safeNext, type RequiredConsent } from '../lib/consent';
import { loadRetention } from '../lib/retention-setting';
import { insertConsents, listRequiredConsents } from '../db/consents';
import { render } from '../render';
import { AccountPage, ConsentPage, DeleteConfirm } from '../views/account';
import { noStore } from './guards';
import type { Context } from 'hono';

export const account = new Hono<AppEnv>();

account.use('/consent', noStore);
account.use('/my/account', noStore);
account.use('/my/account/*', noStore);

const ALL: readonly RequiredConsent[] = REQUIRED_CONSENT_TYPES;

/** 그 회원의 동의 + 지금 받아야 하는 판(보관 기간 설정의 rev 로 정해진다, T-12c). 읽기 두 번을 동시에. */
async function consentState(c: Context<AppEnv>, userId: string) {
  const [rows, retention] = await Promise.all([listRequiredConsents(c.env.DB, userId), loadRetention(c.env.DB)]);
  const required = requiredConsents(retention);
  return { rows, retention, required, missing: missingConsents(rows, required) };
}

/** 동의 화면은 로그인한 관리자 아닌 회원만. 비로그인 → /login, 관리자 → /admin (관리자는 동의 확인 대상이 아니다). */
function consentUser(c: Context<AppEnv>) {
  const u = c.var.user;
  if (!u) return { redirect: c.redirect('/login') } as const;
  if (u.role === 'admin') return { redirect: c.redirect('/admin') } as const;
  return { user: u } as const;
}

account.get('/consent', async (c) => {
  const r = consentUser(c);
  if ('redirect' in r) return r.redirect;
  const next = safeNext(c.req.query('next'));
  const { missing, retention } = await consentState(c, r.user.id);
  if (!missing.length) return c.redirect(next);
  return render(c, <ConsentPage locale={c.var.locale} missing={missing} agreed={ALL.filter((x) => !missing.includes(x))} next={next} retention={retention} />, 'consent.title');
});

account.post('/consent', async (c) => {
  const r = consentUser(c);
  if ('redirect' in r) return r.redirect;
  const f = await c.req.parseBody();
  const next = safeNext(f.next);
  const { missing, retention, required } = await consentState(c, r.user.id);
  if (!missing.length) return c.redirect(next, 303);
  // 화면에는 아직 받지 않은 항목의 체크 칸만 있다. 지금 판에 이미 동의한 항목은 폼 검사에서 체크된 것으로 보고, 기록은 하지 않는다.
  const agreed = Object.fromEntries(ALL.filter((x) => !missing.includes(x)).map((x) => [x, '1']));
  const form = readConsentForm({ ...f, ...agreed });
  if (!form.ok) {
    return render(c, <ConsentPage locale={c.var.locale} missing={missing} agreed={ALL.filter((x) => !missing.includes(x))} next={next} error={form.missing} retention={retention} />, 'consent.title', 400);
  }
  // 기록하는 판은 화면을 그린 때가 아니라 지금(이 요청에서 읽은) 판이다 — 그사이 관리자가 기간을 늘렸으면 새 판으로 남는다.
  await insertConsents(c.env.DB, r.user.id, required.filter((x) => missing.includes(x.type)), now());
  return c.redirect(next, 303);
});

// ── 계정·탈퇴 (모든 로그인 회원. 동의하지 않은 회원도 열 수 있다 — lib/consent 의 예외 주소)
account.use('/my/account', requireRole('seeker', 'company', 'headhunter', 'admin'));
account.use('/my/account/*', requireRole('seeker', 'company', 'headhunter', 'admin'));

async function accountPage(c: Context<AppEnv>, blocks?: DeletionBlock[], status: 200 | 400 = 200) {
  const u = c.var.user!;
  const [st, b] = await Promise.all([consentState(c, u.id), blocks ? Promise.resolve(blocks) : deletionBlocksFor(c.env, u)]);
  return render(c, <AccountPage locale={c.var.locale} email={u.email} role={u.role} consents={st.rows} required={st.required} blocks={b} />, 'acct.title', status);
}

account.get('/my/account', (c) => accountPage(c));

account.get('/my/account/delete', async (c) => {
  const u = c.var.user!;
  const blocks = await deletionBlocksFor(c.env, u);
  if (blocks.length) return accountPage(c, blocks);
  return render(c, <DeleteConfirm locale={c.var.locale} role={u.role} />, 'del.title');
});

account.post('/my/account/delete', async (c) => {
  const u = c.var.user!;
  const f = await c.req.parseBody();
  if (!confirmMatches(f.confirm, u.email)) return render(c, <DeleteConfirm locale={c.var.locale} role={u.role} error />, 'del.title', 400);
  const r = await deleteAccount(c.env, u);
  if (!r.ok && r.blocks.length) return accountPage(c, r.blocks, 400);
  // 탈퇴 완료(또는 이미 탈퇴한 계정): 로그아웃과 같은 방법으로 세션 쿠키를 지운다 (세션 행은 탈퇴 트랜잭션에서 이미 지워졌다).
  await logout(c);
  return c.redirect('/?bye=1', 303);
});
