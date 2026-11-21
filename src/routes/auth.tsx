// 로그인·로그아웃 화면과 처리. 자바스크립트 없이 폼 전송만으로 동작한다.
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Role } from '../env';
import { completeTotp, PENDING_COOKIE, totpStep } from '../lib/admin2fa';
import { logout, requestCode, requireRole, setSessionCookie, TOTP_PENDING_TTL, verifyCode } from '../lib/auth';
import { render } from '../render';
import { LoginCode, LoginRoleNotice, LoginEmail, LoginTotp, MySeeker } from '../views/pages';

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
  if (r.kind === 'totp') {
    // 관리자: 세션 대신 2단계 대기 쿠키만 준다 (10분, /login 경로에서만 전송).
    setCookie(c, PENDING_COOKIE, r.pendingToken, {
      httpOnly: true, secure: c.env.APP_ENV !== 'dev', sameSite: 'Lax', path: '/login', maxAge: TOTP_PENDING_TTL,
    });
    return c.redirect('/login/totp');
  }
  setSessionCookie(c, r.token, r.maxAge);
  // 한 이메일은 한 유형의 계정이다. 이미 가입한 이메일로 다른 유형을 골랐으면 조용히 넘기지 않고 알려 준다.
  // (인증코드를 통과한 본인에게만 보이므로 가입 여부를 남에게 알려 주는 것이 아니다.)
  if (r.user.role !== role) {
    c.set('user', r.user); // 이 응답의 머리글도 로그인 상태로 그린다
    return render(c, <LoginRoleNotice locale={c.var.locale} actual={r.user.role} />, 'login.title');
  }
  return c.redirect('/my');
});

// 관리자 2단계 인증. 처음이면 인증 앱 등록 화면이 함께 나온다.
auth.get('/login/totp', async (c) => {
  const step = await totpStep(c.env, getCookie(c, PENDING_COOKIE));
  if (step.state === 'none') return c.redirect('/login');
  return render(c, <LoginTotp locale={c.var.locale} setup={step.state === 'setup' ? step : undefined} />, 'totp.title');
});

auth.post('/login/totp', async (c) => {
  const f = await c.req.parseBody();
  const token = getCookie(c, PENDING_COOKIE);
  const r = await completeTotp(c.env, token, String(f.code ?? ''));
  if (r.ok) {
    deleteCookie(c, PENDING_COOKIE, { path: '/login' });
    setSessionCookie(c, r.token, r.maxAge);
    return c.redirect('/admin');
  }
  const step = await totpStep(c.env, token);
  if (r.why === 'none' || step.state === 'none') {
    deleteCookie(c, PENDING_COOKIE, { path: '/login' });
    return c.redirect('/login');
  }
  return render(c, <LoginTotp locale={c.var.locale} setup={step.state === 'setup' ? step : undefined} error="totp_invalid" />, 'totp.title');
});

auth.post('/logout', async (c) => {
  await logout(c);
  return c.redirect('/');
});

// 역할별 첫 화면: 구직자는 여기(지원 현황, T-08), 기업·헤드헌터는 /biz, 관리자는 /admin.
auth.get('/my', requireRole('seeker', 'company', 'headhunter', 'admin'), (c) => {
  const u = c.var.user!;
  if (u.role === 'company' || u.role === 'headhunter') return c.redirect('/biz');
  if (u.role === 'admin') return c.redirect('/admin');
  return render(c, <MySeeker locale={c.var.locale} email={u.email} />, 'nav.my');
});

auth.get('/lang/:l', (c) => {
  const l = c.req.param('l') === 'zh' ? 'zh' : 'ko';
  setCookie(c, 'lang', l, { path: '/', maxAge: 365 * 24 * 3600, sameSite: 'Lax' });
  const to = c.req.query('to') ?? '/';
  // 외부 주소로 보내지 않는다 (오픈 리다이렉트 방지)
  return c.redirect(to.startsWith('/') && !to.startsWith('//') ? to : '/');
});
