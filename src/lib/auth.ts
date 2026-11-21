// 이메일 인증코드 로그인과 세션. 비밀번호는 없다.
// 규칙: 코드 6자리·유효 10분·5회 실패 시 폐기·1분에 1회 발송. 세션 30일(관리자 12시간).
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { now, type AppEnv, type Env, type Role, type SessionUser } from '../env';
import { randomCode, randomToken, safeEqual, sha256Hex } from './crypto';
import { sendMail } from './email';
import { t } from './i18n';
import type { Locale } from '../env';

const CODE_TTL = 10 * 60;
const RESEND_GAP = 60;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * 24 * 3600;
const ADMIN_SESSION_TTL = 12 * 3600;
const COOKIE = 'sid';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();
const codeHash = (env: Env, email: string, code: string) => sha256Hex(`${env.SESSION_PEPPER}|${email}|${code}`);
const tokenHash = (env: Env, token: string) => sha256Hex(`${env.SESSION_PEPPER}|${token}`);

export type RequestCodeResult = 'sent' | 'invalid_email' | 'too_soon' | 'mail_failed';

export async function requestCode(env: Env, rawEmail: string, locale: Locale): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 254) return 'invalid_email';
  const ts = now();
  const prev = await env.DB.prepare('SELECT last_sent_at FROM auth_codes WHERE email = ?').bind(email).first<{ last_sent_at: number }>();
  if (prev && ts - prev.last_sent_at < RESEND_GAP) return 'too_soon';
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO auth_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES (?,?,?,0,?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = excluded.last_sent_at`,
  ).bind(email, await codeHash(env, email, code), ts + CODE_TTL, ts).run();
  const ok = await sendMail(env, {
    to: email,
    template: 'auth_code',
    subject: t(locale, 'mail.code.subject'),
    text: t(locale, 'mail.code.body').replace('{code}', code),
  });
  return ok ? 'sent' : 'mail_failed';
}

export type VerifyResult =
  | { ok: true; user: SessionUser; token: string; maxAge: number }
  | { ok: false; why: 'invalid' | 'expired' | 'locked' | 'suspended' };

/**
 * 코드가 맞으면 로그인시킨다. 처음 보는 이메일이면 signupRole 로 회원을 만든다.
 * admin 은 여기서 절대 만들어지지 않는다 (DB 에서 직접 지정).
 */
export async function verifyCode(
  env: Env, rawEmail: string, code: string, signupRole: Exclude<Role, 'admin'>, locale: Locale,
): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const ts = now();
  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM auth_codes WHERE email = ?')
    .bind(email).first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row) return { ok: false, why: 'invalid' };
  if (row.expires_at < ts) return { ok: false, why: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, why: 'locked' };
  if (!/^\d{6}$/.test(code) || !safeEqual(row.code_hash, await codeHash(env, email, code))) {
    await env.DB.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return { ok: false, why: 'invalid' };
  }
  await env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(email).run();

  let user = await env.DB.prepare('SELECT id, email, role, locale, status FROM users WHERE email = ?')
    .bind(email).first<SessionUser & { status: string }>();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, role, locale, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, email, signupRole, locale, 'active', ts, ts).run();
    user = { id, email, role: signupRole, locale, status: 'active' };
  } else {
    if (user.status !== 'active') return { ok: false, why: 'suspended' };
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(ts, user.id).run();
  }
  // TODO(T-03): role 이 admin 이면 여기서 세션을 만들지 말고 TOTP 2단계를 거친다.
  const maxAge = user.role === 'admin' ? ADMIN_SESSION_TTL : SESSION_TTL;
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(await tokenHash(env, token), user.id, ts, ts + maxAge).run();
  return { ok: true, user: { id: user.id, email: user.email, role: user.role, locale: user.locale }, token, maxAge };
}

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAge: number): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: c.env.APP_ENV !== 'dev', sameSite: 'Lax', path: '/', maxAge,
  });
}

export async function logout(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await tokenHash(c.env, token)).run();
  deleteCookie(c, COOKIE, { path: '/' });
}

/** 모든 요청에서 세션을 읽어 c.var.user 에 넣는다 (없으면 null). */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const token = getCookie(c, COOKIE);
  if (token) {
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.role, u.locale FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`,
    ).bind(await tokenHash(c.env, token), now()).first<SessionUser>();
    if (row) c.set('user', row);
  }
  await next();
};

export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const u = c.var.user;
  if (!u) return c.redirect('/login');
  if (!roles.includes(u.role)) return c.text('Forbidden', 403);
  await next();
};

/** 상태를 바꾸는 요청은 같은 출처에서 온 것만 받는다 (CSRF 방어). */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const self = new URL(c.req.url).origin;
    if (!origin || (origin !== self && origin !== c.env.APP_ORIGIN)) return c.text('Bad origin', 403);
  }
  await next();
};
