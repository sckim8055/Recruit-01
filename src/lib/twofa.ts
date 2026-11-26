// 2단계 인증(TOTP) 흐름 — T-03 관리자 필수, T-16 회원 선택·재등록·복구 코드.
//
// 로그인: 이메일 인증코드를 통과한 관리자, 그리고 2단계 인증을 켠 회원은 admin_totp_pending 에 대기 상태로만 남고(세션 없음),
//   여기서 인증 앱 번호 또는 복구 코드를 통과해야 mfa = 1 세션이 만들어진다. 처음 로그인하는 관리자는 이 단계에서 인증 앱을 등록하고 복구 코드를 받는다.
// 계정 화면(/my/account/2fa): 켜기(회원) · 재등록(1단계 지금 번호 또는 복구 코드 → 새 키 → 새 번호로 확정) · 복구 코드 새로 만들기 · 끄기(회원만).
//   등록 중인 새 비밀키는 서버의 totp_enrolments(회원 + 지금 세션, 10분)에만 있다. 폼·주소로 받지 않는다.
// 관리자 초기화: 운영자가 회원(관리자 제외)의 2단계 인증을 지운다 (사유 필수, admin_actions 기록).
// 번호·복구 코드·비밀키는 로그·메일에 넣지 않는다. 알림 메일에는 "무슨 일이 있었는지" 만 적는다.
import { now, type Env, type Locale, type Role, type SessionUser } from '../env';
import { createSession, tokenHash } from './auth';
import { decryptText, encryptText, importEncKey } from './crypto';
import { sendMail } from './email';
import { t } from './i18n';
import { newRecoveryCodes, parseSecondFactor, recoveryHash } from './recovery';
import { base32Decode, newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { consumeTotpPending, deleteTotpPending, findTotpPending, incTotpPendingAttempts, setTotpPendingSecret, type TotpPendingRow } from '../db/sessions';
import { confirmTotp, useTotpStep } from '../db/users';
import {
  clearTotpTries, countUnusedRecoveryCodes, deleteEnrolment, disableTotp, findEnrolment, findTwofaUserByEmail, getTwofaUser,
  incEnrolmentAttempts, insertEnrolment, replaceRecoveryCodes, resetMemberTotp, saveEnrolment, takeTotpTry, useRecoveryCode, type TwofaUserRow,
} from '../db/twofa';

const MAX_ATTEMPTS = 5;
export const PENDING_COOKIE = 'atp';
const ISSUER = 'Recruit';
/** 계정 화면의 등록·재등록 대기 유효 시간. */
export const ENROL_TTL = 10 * 60;
/** 로그인한 상태의 확인(끄기·재등록 1단계·복구 코드 새로 만들기): 회원마다 15분에 5번. */
export const TRY_WINDOW = 15 * 60;
export const TRY_MAX = 5;
/** 관리자 초기화 사유의 최소 길이. */
export const RESET_REASON_MIN = 10;

// ───────── 로그인 2단계

async function loadPending(env: Env, token: string | undefined): Promise<TotpPendingRow | null> {
  if (!token) return null;
  const row = await findTotpPending(env.DB, await tokenHash(env, token));
  if (!row) return null;
  // 만료·횟수 초과·계정 정지, 또는 그사이 2단계 인증이 꺼진 회원(관리자가 아니고 비밀키 없음)이면 대기 상태를 지운다.
  if (row.expires_at < now() || row.attempts >= MAX_ATTEMPTS || row.status !== 'active' || (row.role !== 'admin' && !row.totp_secret)) {
    await deleteTotpPending(env.DB, row.id);
    return null;
  }
  return row;
}

export type TotpStep =
  | { state: 'none' }                                        // 대기 상태 없음 → 로그인부터 다시
  | { state: 'enter'; admin: boolean }                       // 이미 등록됨 → 인증 앱 번호 또는 복구 코드
  | { state: 'setup'; secret: string; uri: string };         // 관리자 최초 등록 → 비밀키를 보여주고 인증번호 입력

/** 화면에 무엇을 보여줄지 정한다. 관리자 최초 등록이면 비밀키를 만들어 대기 행에 암호화해 둔다. */
export async function totpStep(env: Env, token: string | undefined): Promise<TotpStep> {
  const p = await loadPending(env, token);
  if (!p) return { state: 'none' };
  if (p.totp_secret) return { state: 'enter', admin: p.role === 'admin' };
  const key = await importEncKey(env.ENC_KEY);
  let secret: string;
  if (p.secret_new) secret = await decryptText(key, p.secret_new);
  else {
    secret = newTotpSecret();
    await setTotpPendingSecret(env.DB, await encryptText(key, secret), p.id);
  }
  return { state: 'setup', secret, uri: otpauthUri(ISSUER, p.email, secret) };
}

export type TotpResult =
  | {
    ok: true; user: SessionUser; token: string; maxAge: number;
    chosenRole: string | null;            // 로그인 화면에서 고른 유형 (유형 안내용)
    codes?: string[];                     // 관리자 최초 등록: 한 번만 보여 줄 복구 코드
    recoveryLeft?: number;                // 복구 코드로 들어왔다: 남은 개수
  }
  | { ok: false; why: 'none' | 'invalid' };

export async function completeTotp(env: Env, token: string | undefined, raw: string): Promise<TotpResult> {
  const p = await loadPending(env, token);
  if (!p) return { ok: false, why: 'none' };
  const key = await importEncKey(env.ENC_KEY);
  const ts = now();
  const user: SessionUser = { id: p.user_id, email: p.email, role: p.role as Role, locale: p.locale };
  const fail = async (): Promise<TotpResult> => { await incTotpPendingAttempts(env.DB, p.id); return { ok: false, why: 'invalid' }; };

  if (!p.totp_secret) {
    // 관리자 최초 등록: 인증 앱 번호만 받는다. 맞으면 비밀키를 확정하고 복구 코드를 만든다 (대기 상태도 같은 트랜잭션에서 지워진다).
    if (!p.secret_new) return { ok: false, why: 'none' };
    const step = await verifyTotp(base32Decode(await decryptText(key, p.secret_new)), raw.trim(), ts, null);
    if (step === null) return fail();
    const codes = newRecoveryCodes();
    if (!await confirmTotp(env.DB, p.secret_new, step, p.user_id, ts, await codeRows(env, p.user_id, codes))) return { ok: false, why: 'none' };
    const s = await createSession(env, user, true);
    return { ok: true, user, token: s.token, maxAge: s.maxAge, chosenRole: p.chosen_role, codes };
  }

  const f = await useSecondFactor(env, p.user_id, p.totp_secret, p.totp_last_step, raw, true);
  if (!f) return fail();
  // 같은 대기로 세션을 두 번 만들지 않는다 (동시에 들어온 두 요청 중 하나만).
  if (!await consumeTotpPending(env.DB, p.id)) return { ok: false, why: 'none' };
  const s = await createSession(env, user, true);
  if (f === 'recovery') {
    await notice(env, user.email, user.locale, 'recovery_used');
    return { ok: true, user, token: s.token, maxAge: s.maxAge, chosenRole: p.chosen_role, recoveryLeft: await countUnusedRecoveryCodes(env.DB, p.user_id) };
  }
  return { ok: true, user, token: s.token, maxAge: s.maxAge, chosenRole: p.chosen_role };
}

/**
 * 지금 비밀키의 인증 앱 번호(쓴 단계보다 뒤만, 한 문장으로 올림) 또는 쓰지 않은 복구 코드(한 문장으로 사용 표시)를 쓴다.
 * 통과하면 무엇을 썼는지, 아니면 null. allowRecovery = false 면 복구 코드는 받지 않는다.
 */
async function useSecondFactor(
  env: Env, userId: string, encSecret: string, lastStep: number | null, raw: unknown, allowRecovery: boolean,
): Promise<'totp' | 'recovery' | null> {
  const f = parseSecondFactor(raw);
  if (f.kind === 'totp') {
    const secret = await decryptText(await importEncKey(env.ENC_KEY), encSecret);
    const step = await verifyTotp(base32Decode(secret), f.code, now(), lastStep);
    return step !== null && await useTotpStep(env.DB, userId, encSecret, step) ? 'totp' : null;
  }
  if (f.kind === 'recovery' && allowRecovery) {
    return await useRecoveryCode(env.DB, userId, await recoveryHash(env.SESSION_PEPPER, userId, f.code), now()) ? 'recovery' : null;
  }
  return null;
}

async function codeRows(env: Env, userId: string, codes: string[]) {
  return Promise.all(codes.map(async (c) => ({ id: crypto.randomUUID(), hash: await recoveryHash(env.SESSION_PEPPER, userId, c) })));
}

// ───────── 알림 메일 (비밀값·번호·코드 없음)

export type NoticeKind = 'enabled' | 'disabled' | 'reenrolled' | 'codes_new' | 'recovery_used' | 'reset_by_admin';

async function notice(env: Env, to: string, locale: Locale, kind: NoticeKind): Promise<void> {
  await sendMail(env, {
    to, template: `totp_${kind}`,
    subject: t(locale, `mail.2fa.${kind}.subject`),
    text: `${t(locale, `mail.2fa.${kind}.body`)}\n\n${t(locale, 'mail.2fa.footer')}`,
  });
}

// ───────── 계정 화면 (/my/account/2fa)

export interface TwofaOverview {
  enabled: boolean; since: number | null; remaining: number;
  enrolling: { secret: string; uri: string } | null;   // 이 세션에서 등록·재등록 중(서버 대기)이면 새 키
}

async function liveEnrolment(env: Env, userId: string, sessionId: string) {
  const e = await findEnrolment(env.DB, userId, sessionId);
  if (!e) return null;
  if (e.expires_at < now() || e.attempts >= MAX_ATTEMPTS) { await deleteEnrolment(env.DB, e.id); return null; }
  return e;
}

/** 계정 화면의 상자: 켜졌는가·켠 시각·남은 복구 코드 수 (비밀키는 돌려주지 않는다). */
export async function twofaStatus(env: Env, userId: string): Promise<Omit<TwofaOverview, 'enrolling'>> {
  const [u, remaining] = await Promise.all([getTwofaUser(env.DB, userId), countUnusedRecoveryCodes(env.DB, userId)]);
  return { enabled: !!u?.totp_secret, since: u?.totp_enabled_at ?? null, remaining: u?.totp_secret ? remaining : 0 };
}

export async function twofaOverview(env: Env, user: SessionUser, sessionId: string): Promise<TwofaOverview> {
  const [st, e] = await Promise.all([twofaStatus(env, user.id), liveEnrolment(env, user.id, sessionId)]);
  if (!e) return { ...st, enrolling: null };
  const secret = await decryptText(await importEncKey(env.ENC_KEY), e.secret_new);
  return { ...st, enrolling: { secret, uri: otpauthUri(ISSUER, user.email, secret) } };
}

async function newEnrolment(env: Env, user: SessionUser, sessionId: string): Promise<void> {
  const enc = await encryptText(await importEncKey(env.ENC_KEY), newTotpSecret());
  const ts = now();
  await insertEnrolment(env.DB, { id: crypto.randomUUID(), userId: user.id, sessionId, encSecret: enc, expiresAt: ts + ENROL_TTL, ts });
}

/** 켜기 시작 (아직 2단계 인증이 꺼져 있을 때만). 켜져 있으면 재등록(1단계 확인)을 거쳐야 한다. */
export async function startEnrolment(env: Env, user: SessionUser, sessionId: string): Promise<'ok' | 'already_on'> {
  const u = await getTwofaUser(env.DB, user.id);
  if (!u || u.totp_secret) return 'already_on';
  await newEnrolment(env, user, sessionId);
  return 'ok';
}

export type CheckResult = 'ok' | 'invalid' | 'locked' | 'off';

/**
 * 로그인한 상태에서 지금 2단계를 다시 확인한다. 회원별 시도 한도(15분 5번)를 먼저 잡고(잠겼으면 locked — 번호를 보지 않는다),
 * 통과하면 시도 수를 되돌린다. allowRecovery = 복구 코드도 받는가.
 */
async function checkCurrent(env: Env, u: TwofaUserRow, raw: unknown, allowRecovery: boolean): Promise<{ r: CheckResult; used?: 'totp' | 'recovery' }> {
  if (!u.totp_secret) return { r: 'off' };
  const ts = now();
  if (!await takeTotpTry(env.DB, u.id, ts, ts - TRY_WINDOW, TRY_MAX)) return { r: 'locked' };
  const used = await useSecondFactor(env, u.id, u.totp_secret, u.totp_last_step, raw, allowRecovery);
  if (!used) return { r: 'invalid' };
  await clearTotpTries(env.DB, u.id);
  return { r: 'ok', used };
}

/** 재등록 1단계: 지금 번호 또는 복구 코드 → 통과하면 새 키로 등록 대기를 만든다. 예전 키는 확정 전까지 그대로 유효하다. */
export async function startReenrol(env: Env, user: SessionUser, sessionId: string, raw: unknown): Promise<CheckResult> {
  const u = await getTwofaUser(env.DB, user.id);
  if (!u) return 'off';
  const c = await checkCurrent(env, u, raw, true);
  if (c.r !== 'ok') return c.r;
  if (c.used === 'recovery') await notice(env, user.email, user.locale, 'recovery_used');
  await newEnrolment(env, user, sessionId);
  return 'ok';
}

export type ConfirmResult = { ok: true; codes: string[]; first: boolean } | { ok: false; why: 'none' | 'invalid' };

/**
 * 켜기·재등록 확정: 서버 대기의 새 키로 만든 번호가 맞으면 비밀키를 저장(교체)하고, 지금 세션 mfa = 1, 다른 세션 모두 삭제,
 * 복구 코드 8개를 새로 만든다(예전 것은 무효). 알림 메일. 틀리면 대기의 시도 수를 올린다(5번이면 대기 삭제).
 */
export async function confirmEnrolment(env: Env, user: SessionUser, sessionId: string, raw: unknown): Promise<ConfirmResult> {
  const e = await liveEnrolment(env, user.id, sessionId);
  if (!e) return { ok: false, why: 'none' };
  const u = await getTwofaUser(env.DB, user.id);
  if (!u) return { ok: false, why: 'none' };
  const code = typeof raw === 'string' ? raw.replace(/\s/g, '') : '';
  const ts = now();
  const step = await verifyTotp(base32Decode(await decryptText(await importEncKey(env.ENC_KEY), e.secret_new)), code, ts, null);
  if (step === null) { await incEnrolmentAttempts(env.DB, e.id); return { ok: false, why: 'invalid' }; }
  const codes = newRecoveryCodes();
  const first = !u.totp_secret;
  const saved = await saveEnrolment(env.DB, {
    userId: user.id, sessionId, enrolmentId: e.id, oldSecret: u.totp_secret, newSecret: e.secret_new, step, ts, codes: await codeRows(env, user.id, codes),
  });
  if (!saved) return { ok: false, why: 'none' };
  await notice(env, user.email, user.locale, first ? 'enabled' : 'reenrolled');
  return { ok: true, codes, first };
}

/** 등록 대기 취소 (이 세션의 것만). */
export async function cancelEnrolment(env: Env, user: SessionUser, sessionId: string): Promise<void> {
  const e = await findEnrolment(env.DB, user.id, sessionId);
  if (e) await deleteEnrolment(env.DB, e.id);
}

/** 복구 코드 새로 만들기: 지금 인증 앱 번호가 필요하다(복구 코드로는 안 됨). 예전 코드는 모두 무효. */
export async function regenerateCodes(env: Env, user: SessionUser, raw: unknown): Promise<{ ok: true; codes: string[] } | { ok: false; why: CheckResult }> {
  const u = await getTwofaUser(env.DB, user.id);
  if (!u) return { ok: false, why: 'off' };
  const c = await checkCurrent(env, u, raw, false);
  if (c.r !== 'ok') return { ok: false, why: c.r };
  const codes = newRecoveryCodes();
  if (!await replaceRecoveryCodes(env.DB, user.id, u.totp_secret!, await codeRows(env, user.id, codes), now())) return { ok: false, why: 'off' };
  await notice(env, user.email, user.locale, 'codes_new');
  return { ok: true, codes };
}

/** 끄기 (회원만): 지금 번호 또는 쓰지 않은 복구 코드가 필요하다. 관리자는 끌 수 없다. */
export async function disable2fa(env: Env, user: SessionUser, raw: unknown): Promise<CheckResult | 'forbidden'> {
  if (user.role === 'admin') return 'forbidden';
  const u = await getTwofaUser(env.DB, user.id);
  if (!u) return 'off';
  if (u.role === 'admin') return 'forbidden';
  const c = await checkCurrent(env, u, raw, true);
  if (c.r !== 'ok') return c.r;
  if (!await disableTotp(env.DB, user.id, u.totp_secret!)) return 'off';
  await notice(env, user.email, user.locale, 'disabled');
  return 'ok';
}

// ───────── 관리자 초기화 (/admin/users/2fa-reset)

export type ResetCheck =
  | { ok: true; target: { id: string; email: string; role: string } }
  | { ok: false; why: 'reason' | 'no_user' | 'admin' | 'not_on' };

const normEmail = (raw: unknown) => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');
export const resetReason = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/** 입력 검사 + 대상 찾기 (확인 화면·실행 모두 이것으로 다시 검사한다). 관리자 계정은 대상이 아니다(README 의 DB 명령). */
export async function checkReset(env: Env, rawEmail: unknown, rawReason: unknown): Promise<ResetCheck> {
  if ([...resetReason(rawReason)].length < RESET_REASON_MIN) return { ok: false, why: 'reason' };
  const u = await findTwofaUserByEmail(env.DB, normEmail(rawEmail));
  if (!u || u.status === 'deleted') return { ok: false, why: 'no_user' };
  if (u.role === 'admin') return { ok: false, why: 'admin' };
  if (!u.totp_secret) return { ok: false, why: 'not_on' };
  return { ok: true, target: { id: u.id, email: u.email, role: u.role } };
}

export async function resetMember(env: Env, admin: SessionUser, rawEmail: unknown, rawReason: unknown): Promise<ResetCheck> {
  const c = await checkReset(env, rawEmail, rawReason);
  if (!c.ok) return c;
  const done = await resetMemberTotp(env.DB, {
    actionId: crypto.randomUUID(), actorId: admin.id, targetId: c.target.id, reason: resetReason(rawReason), ts: now(),
  });
  if (!done) return { ok: false, why: 'not_on' };
  const u = await getTwofaUser(env.DB, c.target.id);
  await notice(env, c.target.email, u?.locale ?? 'ko', 'reset_by_admin');
  return c;
}
