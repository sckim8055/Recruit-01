// 관리자 2단계 인증 흐름. 이메일 인증코드를 통과한 관리자는 admin_totp_pending 에 대기 상태로만 남고,
// 여기서 TOTP 를 통과해야 세션이 만들어진다. 처음 로그인하는 관리자는 이 단계에서 인증 앱을 등록한다.
import { now, type Env, type SessionUser } from '../env';
import { createSession, tokenHash } from './auth';
import { decryptText, encryptText, importEncKey } from './crypto';
import { base32Decode, newTotpSecret, otpauthUri, verifyTotp } from './totp';

const MAX_ATTEMPTS = 5;
export const PENDING_COOKIE = 'atp';

interface PendingRow {
  id: string; user_id: string; secret_new: string | null; attempts: number; expires_at: number;
  email: string; locale: 'ko' | 'zh'; role: string; status: string; totp_secret: string | null; totp_last_step: number | null;
}

async function loadPending(env: Env, token: string | undefined): Promise<PendingRow | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.secret_new, p.attempts, p.expires_at,
            u.email, u.locale, u.role, u.status, u.totp_secret, u.totp_last_step
     FROM admin_totp_pending p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
  ).bind(await tokenHash(env, token)).first<PendingRow>();
  if (!row) return null;
  // 만료·횟수 초과·권한 변경이면 대기 상태를 지운다.
  if (row.expires_at < now() || row.attempts >= MAX_ATTEMPTS || row.role !== 'admin' || row.status !== 'active') {
    await env.DB.prepare('DELETE FROM admin_totp_pending WHERE id = ?').bind(row.id).run();
    return null;
  }
  return row;
}

export type TotpStep =
  | { state: 'none' }                                        // 대기 상태 없음 → 로그인부터 다시
  | { state: 'enter' }                                       // 이미 등록된 관리자 → 인증번호 입력
  | { state: 'setup'; secret: string; uri: string };         // 최초 등록 → 비밀키를 보여주고 인증번호 입력

/** 화면에 무엇을 보여줄지 정한다. 최초 등록이면 비밀키를 만들어 대기 행에 암호화해 둔다. */
export async function totpStep(env: Env, token: string | undefined): Promise<TotpStep> {
  const p = await loadPending(env, token);
  if (!p) return { state: 'none' };
  if (p.totp_secret) return { state: 'enter' };
  const key = await importEncKey(env.ENC_KEY);
  let secret: string;
  if (p.secret_new) secret = await decryptText(key, p.secret_new);
  else {
    secret = newTotpSecret();
    await env.DB.prepare('UPDATE admin_totp_pending SET secret_new = ? WHERE id = ?')
      .bind(await encryptText(key, secret), p.id).run();
  }
  return { state: 'setup', secret, uri: otpauthUri('Recruit', p.email, secret) };
}

export type TotpResult =
  | { ok: true; user: SessionUser; token: string; maxAge: number }
  | { ok: false; why: 'none' | 'invalid' };

export async function completeTotp(env: Env, token: string | undefined, code: string): Promise<TotpResult> {
  const p = await loadPending(env, token);
  if (!p) return { ok: false, why: 'none' };
  const enc = p.totp_secret ?? p.secret_new;
  if (!enc) return { ok: false, why: 'none' };
  const secret = await decryptText(await importEncKey(env.ENC_KEY), enc);
  const step = await verifyTotp(base32Decode(secret), code.trim(), now(), p.totp_last_step);
  if (step === null) {
    await env.DB.prepare('UPDATE admin_totp_pending SET attempts = attempts + 1 WHERE id = ?').bind(p.id).run();
    return { ok: false, why: 'invalid' };
  }
  // 통과: 최초 등록이면 비밀키를 확정하고, 쓴 시간 단계를 기록한 뒤 대기 상태를 지운다.
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?').bind(enc, step, p.user_id),
    env.DB.prepare('DELETE FROM admin_totp_pending WHERE user_id = ?').bind(p.user_id),
  ]);
  const user: SessionUser = { id: p.user_id, email: p.email, role: 'admin', locale: p.locale };
  const s = await createSession(env, user, true);
  return { ok: true, user, token: s.token, maxAge: s.maxAge };
}
