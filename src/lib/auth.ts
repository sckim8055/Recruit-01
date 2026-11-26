// 이메일 인증코드 로그인과 세션. 비밀번호는 없다.
// 규칙: 코드 6자리·유효 10분·5회 실패 시 폐기·1분에 1회 발송. 세션 30일(관리자 12시간).
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { now, type AppEnv, type Env, type Role, type SessionUser } from '../env';
import { randomCode, randomToken, safeEqual, sha256Hex } from './crypto';
import { sendMail } from './email';
import { t } from './i18n';
import { renderError } from '../render';
import {
  deleteAuthCode, deleteSession, deleteTotpPendingForUser, findSessionUser, getAuthCode, getAuthCodeSentAt, incAuthCodeAttempts,
  insertSession, insertTotpPending, upsertAuthCode,
} from '../db/sessions';
import { findUserByEmail, insertUser, touchUserLogin } from '../db/users';
import type { Locale } from '../env';

const CODE_TTL = 10 * 60;
const RESEND_GAP = 60;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * 24 * 3600;
const ADMIN_SESSION_TTL = 12 * 3600;
export const TOTP_PENDING_TTL = 10 * 60;
const COOKIE = 'sid';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();
const codeHash = (env: Env, email: string, code: string) => sha256Hex(`${env.SESSION_PEPPER}|${email}|${code}`);
export const tokenHash = (env: Env, token: string) => sha256Hex(`${env.SESSION_PEPPER}|${token}`);

export type RequestCodeResult = 'sent' | 'invalid_email' | 'too_soon' | 'mail_failed';

export async function requestCode(env: Env, rawEmail: string, locale: Locale): Promise<RequestCodeResult> {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 254) return 'invalid_email';
  const ts = now();
  const prev = await getAuthCodeSentAt(env.DB, email);
  if (prev && ts - prev.last_sent_at < RESEND_GAP) return 'too_soon';
  const code = randomCode();
  await upsertAuthCode(env.DB, email, await codeHash(env, email, code), ts + CODE_TTL, ts);
  const ok = await sendMail(env, {
    to: email,
    template: 'auth_code',
    subject: t(locale, 'mail.code.subject'),
    text: t(locale, 'mail.code.body').replace('{code}', code),
  });
  return ok ? 'sent' : 'mail_failed';
}

export type VerifyResult =
  | { ok: true; kind: 'session'; user: SessionUser; token: string; maxAge: number }
  // 관리자와 2단계 인증을 켠 회원은 여기서 세션을 받지 못한다. TOTP(또는 복구 코드)를 통과해야 한다 (src/lib/twofa.ts).
  // 이 결과는 인증코드를 맞힌 뒤에만 나온다 — 이메일 단계(requestCode)는 2단계 인증 여부와 관계없이 같다.
  | { ok: true; kind: 'totp'; pendingToken: string }
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
  const row = await getAuthCode(env.DB, email);
  if (!row) return { ok: false, why: 'invalid' };
  if (row.expires_at < ts) return { ok: false, why: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, why: 'locked' };
  if (!/^\d{6}$/.test(code) || !safeEqual(row.code_hash, await codeHash(env, email, code))) {
    await incAuthCodeAttempts(env.DB, email);
    return { ok: false, why: 'invalid' };
  }
  await deleteAuthCode(env.DB, email);

  let user = await findUserByEmail(env.DB, email);
  if (!user) {
    const id = crypto.randomUUID();
    await insertUser(env.DB, id, email, signupRole, locale, 'active', ts, ts);
    user = { id, email, role: signupRole, locale, status: 'active', totp_on: 0 };
  } else {
    if (user.status !== 'active') return { ok: false, why: 'suspended' };
    await touchUserLogin(env.DB, ts, user.id);
  }
  const su: SessionUser = { id: user.id, email: user.email, role: user.role, locale: user.locale };
  if (su.role === 'admin' || user.totp_on === 1) {
    // 관리자·2단계 인증을 켠 회원은 이메일 인증코드만으로 로그인할 수 없다. 2단계(TOTP) 대기 상태만 만든다.
    // 고른 유형(signupRole)은 2단계를 통과한 뒤 유형 안내를 지금처럼 보이기 위해 대기에 남긴다.
    const pendingToken = randomToken();
    await deleteTotpPendingForUser(env.DB, su.id, ts);
    await insertTotpPending(env.DB, await tokenHash(env, pendingToken), su.id, ts + TOTP_PENDING_TTL, signupRole);
    return { ok: true, kind: 'totp', pendingToken };
  }
  const { token, maxAge } = await createSession(env, su, false);
  return { ok: true, kind: 'session', user: su, token, maxAge };
}

/** 세션을 만든다. mfa = true 는 TOTP(또는 복구 코드)를 통과했다는 뜻이며 twofa.ts 만 true 로 부른다. */
export async function createSession(env: Env, user: SessionUser, mfa: boolean): Promise<{ token: string; maxAge: number }> {
  const ts = now();
  const maxAge = user.role === 'admin' ? ADMIN_SESSION_TTL : SESSION_TTL;
  const token = randomToken();
  await insertSession(env.DB, await tokenHash(env, token), user.id, ts, ts + maxAge, mfa ? 1 : 0);
  return { token, maxAge };
}

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAge: number): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: c.env.APP_ENV !== 'dev', sameSite: 'Lax', path: '/', maxAge,
  });
}

export async function logout(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await deleteSession(c.env.DB, await tokenHash(c.env, token));
  deleteCookie(c, COOKIE, { path: '/' });
}

/**
 * 이 세션으로 로그인한 것으로 볼 수 있는가. 순수 함수 (test/auth.test.ts).
 * 관리자, 그리고 2단계 인증을 켠 계정(totpOn = 1)은 TOTP 를 통과한 세션(mfa = 1)만 인정한다.
 */
export function sessionUsable(role: Role, mfa: number, totpOn: number): boolean {
  if (mfa === 1) return true;
  return role !== 'admin' && totpOn !== 1;
}

/** 지금 요청의 세션 id (= 쿠키 토큰의 해시, sessions.id). 쿠키가 없으면 null. 2단계 등록 대기를 세션에 묶을 때 쓴다. */
export async function currentSessionId(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, COOKIE);
  return token ? tokenHash(c.env, token) : null;
}

/** 모든 요청에서 세션을 읽어 c.var.user 에 넣는다 (없으면 null). */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const token = getCookie(c, COOKIE);
  if (token) {
    const row = await findSessionUser(c.env.DB, await tokenHash(c.env, token), now());
    // 관리자와 2단계 인증을 켠 회원은 TOTP 를 통과한 세션만 인정한다. 그렇지 않은 세션은 로그인하지 않은 것으로 본다 (판단은 이곳 한 곳).
    if (row && sessionUsable(row.role, row.mfa, row.totp_on)) c.set('user', { id: row.id, email: row.email, role: row.role, locale: row.locale });
  }
  await next();
};

export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const u = c.var.user;
  if (!u) return c.redirect('/login');
  if (!roles.includes(u.role)) return renderError(c, 403);
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
