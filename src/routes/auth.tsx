// 로그인·로그아웃 화면과 처리. 자바스크립트 없이 폼 전송만으로 동작한다.
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppEnv, Role } from '../env';
import { logout, requestCode, requireRole, setSessionCookie, verifyCode } from '../lib/auth';
import { render } from '../render';
import { LoginCode, LoginEmail, My } from '../views/pages';

export const auth = new Hono<AppEnv>();

// 가입 화면에서 고를 수 있는 유형. headhunter 는 FLAG_HEADHUNTER_POSTING 이 켜진 뒤에만 받는다.
function signupRole(raw: unknown, headhunterOn: boolean): Exclude<Role, 'admin'> {
  if (raw === 'company') return 'company';
  if (raw === 'headhunter' && headhunterOn) return 'headhunter';
  return 'seeker';
}

auth.get('/login', (c) => (c.var.user ? c.redirect('/my') : render(c, <LoginEmail locale={c.var.locale} />, 'login.title')));

auth.post('/login/request', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '');
  const role = signupRole(f.role, c.env.FLAG_HEADHUNTER_POSTING === 'on');
  const r = await requestCode(c.env, email, c.var.locale);
  if (r === 'invalid_email' || r === 'mail_failed') return render(c, <LoginEmail locale={c.var.locale} error={r} />, 'login.title');
  // too_soon 이어도 코드 입력 화면으로 보낸다 (직전에 보낸 코드를 쓸 수 있다).
  return render(c, <LoginCode locale={c.var.locale} email={email} role={role} error={r === 'too_soon' ? r : undefined} />, 'login.title');
});

auth.post('/login/verify', async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? '');
  const role = signupRole(f.role, c.env.FLAG_HEADHUNTER_POSTING === 'on');
  const r = await verifyCode(c.env, email, String(f.code ?? '').trim(), role, c.var.locale);
  if (!r.ok) return render(c, <LoginCode locale={c.var.locale} email={email} role={role} error={r.why} />, 'login.title');
  setSessionCookie(c, r.token, r.maxAge);
  return c.redirect('/my');
});

auth.post('/logout', async (c) => {
  await logout(c);
  return c.redirect('/');
});

auth.get('/my', requireRole('seeker', 'company', 'headhunter', 'admin'), (c) => {
  const u = c.var.user!;
  return render(c, <My locale={c.var.locale} email={u.email} role={u.role} />, 'nav.my');
});

auth.get('/lang/:l', (c) => {
  const l = c.req.param('l') === 'zh' ? 'zh' : 'ko';
  setCookie(c, 'lang', l, { path: '/', maxAge: 365 * 24 * 3600, sameSite: 'Lax' });
  const to = c.req.query('to') ?? '/';
  // 외부 주소로 보내지 않는다 (오픈 리다이렉트 방지)
  return c.redirect(to.startsWith('/') && !to.startsWith('//') ? to : '/');
});
