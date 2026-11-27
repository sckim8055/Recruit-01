// T-16 2단계 인증: 회원 켜기·로그인·복구 코드·끄기, 관리자 재등록·최초 등록 복구 코드, 관리자 초기화, 시도 한도, 정리 작업.
// app.fetch 로 라우트 전체를 돈다. SQLite 메모리 DB(test/sqlite-d1.ts). 모든 계정·번호는 가짜다 (CLAUDE.md 규칙 10).
// 시계는 Date.now 를 고정해 30초 단계를 직접 넘긴다 (같은 번호 재사용 거부를 확인하기 위해).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { formatRecoveryCode, newRecoveryCodes, normalizeRecoveryCode, parseSecondFactor, RECOVERY_ALPHABET, recoveryHash } from '../src/lib/recovery';
import { base32Decode, totpAt } from '../src/lib/totp';
import { useRecoveryCode } from '../src/db/twofa';
import { STEPS } from '../src/lib/maintenance';
import { deleteAccount } from '../src/lib/account';
import { agreeRequired } from './consent-fixture';
import { hasDb, migratedDb } from './pg-test-db';

const ENC_KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'test-pepper-2fa';
const ORIGIN = 'http://localhost';
const NO_STORE = 'private, no-store';
const T0 = 1_800_000_010; // 30초 단계의 시작 근처

const EMAILS = { s1: 'fake.tfa.seeker@example.test', s2: 'fake.tfa.other@example.test', co: 'fake.tfa.company@example.test', adm: 'fake.tfa.adm@example.test', adm2: 'fake.tfa.newadm@example.test' };
type Who = keyof typeof EMAILS;

let clock = T0;
const tick = (sec = 30) => { clock += sec; };
let out: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
/** 이 테스트에서 화면에 나온 비밀키·복구 코드 (콘솔·메일에 나오면 안 된다). */
let secrets: string[] = [];

beforeEach(() => {
  clock = T0; out = []; secrets = [];
  spies = [
    vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000),
    ...(['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); })),
  ];
});
afterEach(() => {
  // 콘솔(개발용 메일 출력 포함)에 비밀키·복구 코드가 나오지 않는다. 2단계 알림 메일에는 6자리 번호도 없다.
  const all = out.join('\n');
  for (const s of secrets) expect(all).not.toContain(s);
  for (const m of mails()) if (m.template.startsWith('totp_')) expect(m.text).not.toMatch(/\b\d{6}\b/);
  spies.forEach((s) => s.mockRestore());
});

/** 개발용 메일 출력(lib/email.sendMail, APP_ENV = dev)을 읽는다. */
function mails(): { template: string; to: string; text: string }[] {
  return out.filter((x) => x.startsWith('[mail:')).map((x) => {
    const m = /^\[mail:([^\]]+)] to=(\S+)\n([\s\S]*)$/.exec(x)!;
    return { template: m[1]!, to: m[2]!, text: m[3]! };
  });
}

function world() {
  const { raw, d1 } = migratedDb();
  const roles: Record<Who, string> = { s1: 'seeker', s2: 'seeker', co: 'company', adm: 'admin', adm2: 'admin' };
  for (const [id, role] of Object.entries(roles)) {
    raw.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?,?,?,'active',0)").run(id, EMAILS[id as Who], role);
    agreeRequired(raw, id);
  }
  const env = {
    APP_ENV: 'dev', APP_ORIGIN: ORIGIN, DB: d1, ENC_KEY, SESSION_PEPPER: PEPPER, REGISTRATION_NO: '', MAIL_FROM: '',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  let k = 0;
  /** 세션을 직접 만든다 (mfa 0/1). 쿠키 토큰을 돌려준다. */
  const session = async (who: Who, mfa: number) => {
    const token = `tok-${who}-${k++}`;
    raw.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
      .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, mfa);
    return token;
  };
  const req = (path: string, o: { method?: string; sid?: string; atp?: string; form?: Record<string, string>; lang?: string } = {}) => {
    const cookie = [`lang=${o.lang ?? 'ko'}`, o.sid ? `sid=${o.sid}` : '', o.atp ? `atp=${o.atp}` : ''].filter(Boolean).join('; ');
    const headers: Record<string, string> = { cookie };
    if (o.form || o.method === 'POST') { headers.origin = ORIGIN; headers['content-type'] = 'application/x-www-form-urlencoded'; }
    return app.fetch(new Request(`${ORIGIN}${path}`, { method: o.form ? 'POST' : (o.method ?? 'GET'), headers, body: o.form ? new URLSearchParams(o.form) : undefined }) as never, env);
  };
  const one = (sql: string, ...a: unknown[]) => { const r = raw.prepare(sql).get(...(a as never[])); return r ? { ...r } : undefined; };
  const n = (sql: string, ...a: unknown[]) => Number(raw.prepare(sql).get(...(a as never[]))!.n);
  const code = (secret: string) => totpAt(base32Decode(secret), clock);
  return { raw, db: d1, env, session, req, one, n, code };
}
type W = ReturnType<typeof world>;

const cookieOf = (res: Response, name: string): string | null => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  for (const c of all) { const m = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(c); if (m && m[1]) return m[1]; }
  return null;
};
const secretOf = (html: string) => { const m = /<p class="secret">([A-Z2-7 ]+)<\/p>/.exec(html); return m ? m[1]!.replace(/ /g, '') : null; };
const codesOf = (html: string) => [...html.matchAll(/<li>([A-Z2-9]{5}-[A-Z2-9]{5})<\/li>/g)].map((m) => m[1]!);
const remember = (...xs: (string | null | undefined)[]) => { for (const x of xs) if (x) secrets.push(x, x.replace('-', '')); };

/** 계정 화면에서 2단계 인증을 켠다 (회원). 비밀키와 복구 코드를 돌려준다. */
async function enable(w: W, sid: string) {
  expect((await w.req('/my/account/2fa/start', { sid, method: 'POST' })).status).toBe(303);
  const page = await (await w.req('/my/account/2fa', { sid })).text();
  const secret = secretOf(page)!;
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const res = await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(secret) } });
  expect(res.status).toBe(200);
  const codes = codesOf(await res.text());
  remember(secret, ...codes);
  return { secret, codes };
}

/** 이메일 인증코드 로그인 (개발용 메일 출력에서 코드를 읽는다). */
async function emailLogin(w: W, email: string, role = 'seeker') {
  const before = out.length;
  const r1 = await w.req('/login/request', { form: { email, role } });
  const body1 = await r1.text();
  const m = out.slice(before).join('\n').match(/인증코드: (\d{6})/)!;
  const res = await w.req('/login/verify', { form: { email, role, code: m[1]! } });
  return { res, body1 };
}

describe('복구 코드 (순수 함수)', () => {
  it('8개, 10자, 헷갈리는 글자 없음, 서로 다름, XXXXX-XXXXX 표시', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{10}$/);
      expect(c).not.toMatch(/[01OIL]/);
      expect(formatRecoveryCode(c)).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
    expect(RECOVERY_ALPHABET).toHaveLength(31);
  });
  it('입력 정규화: 대소문자·공백·하이픈 무시, 모양이 다르면 거부', () => {
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABC DE FGH-JK')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDEFGHJ')).toBeNull();
    expect(normalizeRecoveryCode('ABCDEFGHJ0')).toBeNull();
    expect(normalizeRecoveryCode('ABCDEFGHJI')).toBeNull();
    expect(parseSecondFactor(' 123 456 ')).toEqual({ kind: 'totp', code: '123456' });
    expect(parseSecondFactor('abcde-fghjk')).toEqual({ kind: 'recovery', code: 'ABCDEFGHJK' });
    expect(parseSecondFactor('12345')).toEqual({ kind: 'bad' });
    expect(parseSecondFactor(undefined)).toEqual({ kind: 'bad' });
  });
  it('해시는 회원마다 다르다 (같은 코드라도)', async () => {
    expect(await recoveryHash('p', 'u1', 'ABCDEFGHJK')).not.toBe(await recoveryHash('p', 'u2', 'ABCDEFGHJK'));
  });
});

describe.skipIf(!hasDb)('회원: 2단계 인증 켜기', () => {
  it('새 키는 서버 대기에만 있고, 확인하면 지금 세션 mfa = 1 · 다른 세션 삭제 · 복구 코드 8개(해시) · 알림 메일', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const other = await w.session('s1', 0);
    const elsewhere = await w.session('s2', 0);
    const acct = await (await w.req('/my/account', { sid })).text();
    expect(acct).toContain('2단계 인증');
    expect(acct).toContain('꺼짐');

    const g = await w.req('/my/account/2fa', { sid });
    expect(g.headers.get('cache-control')).toBe(NO_STORE);
    expect(await g.text()).not.toContain('class="secret"');
    await w.req('/my/account/2fa/start', { sid, method: 'POST' });
    const page = await w.req('/my/account/2fa', { sid });
    expect(page.headers.get('cache-control')).toBe(NO_STORE);
    const html = await page.text();
    const secret = secretOf(html)!;
    remember(secret);
    expect(html).toContain('Microsoft Authenticator, Google Authenticator, 1Password, 腾讯身份验证器');
    expect(html).toContain('<svg');
    // 대기는 이 세션에만 묶인다: 다른 세션에서는 키가 보이지 않는다
    expect(secretOf(await (await w.req('/my/account/2fa', { sid: other })).text())).toBeNull();
    const enc = w.one('SELECT secret_new FROM totp_enrolments WHERE user_id = ?', 's1')!.secret_new as string;
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain(secret);

    // 폼으로 보낸 다른 비밀키는 쓰지 않는다
    const fake = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const bad = await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(fake), secret: fake } });
    expect(bad.status).toBe(400);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).toBeNull();
    // 다른 세션에서 맞는 번호를 보내도 그 세션에는 대기가 없다
    expect((await w.req('/my/account/2fa/confirm', { sid: other, form: { code: await w.code(secret) } })).status).toBe(400);

    const ok = await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(secret) } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe(NO_STORE);
    const okHtml = await ok.text();
    const codes = codesOf(okHtml);
    remember(...codes);
    expect(codes).toHaveLength(8);
    expect(okHtml).toContain('저장했습니다 → 계속');
    const u = w.one('SELECT totp_secret, totp_last_step, totp_enabled_at FROM users WHERE id = ?', 's1')!;
    expect(String(u.totp_secret).startsWith('v1.')).toBe(true);
    expect(u.totp_last_step).toBe(Math.floor(clock / 30));
    expect(u.totp_enabled_at).toBe(clock);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', 's1')).toBe(1);
    expect(w.one('SELECT mfa FROM sessions WHERE user_id = ?', 's1')!.mfa).toBe(1);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', 's2')).toBe(1);
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(0);
    const hashes = (w.raw.prepare('SELECT code_hash FROM totp_recovery_codes WHERE user_id = ?').all('s1') as { code_hash: string }[]).map((r) => r.code_hash);
    expect(hashes).toHaveLength(8);
    for (const c of codes) expect(hashes).toContain(await recoveryHash(PEPPER, 's1', c.replace('-', '')));
    // 지운 세션은 로그아웃 상태, 지금 세션은 그대로
    expect((await w.req('/my/account', { sid: other })).headers.get('location')).toBe('/login');
    expect((await w.req('/my/account', { sid })).status).toBe(200);
    expect((await w.req('/my/account', { sid: elsewhere })).status).toBe(200);
    const m = mails().filter((x) => x.template === 'totp_enabled');
    expect(m).toHaveLength(1);
    expect(m[0]!.to).toBe(EMAILS.s1);
    // 계정 화면: 켜짐 + 남은 8개
    const acct2 = await (await w.req('/my/account', { sid })).text();
    expect(acct2).toContain('켜짐');
    expect(acct2).toContain('8개');
  });

  it('등록 대기는 5번 틀리면 지워지고, 10분이 지나면 만료된다', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    await w.req('/my/account/2fa/start', { sid, method: 'POST' });
    remember(secretOf(await (await w.req('/my/account/2fa', { sid })).text()));
    for (let i = 0; i < 5; i++) expect((await w.req('/my/account/2fa/confirm', { sid, form: { code: '000000' } })).status).toBe(400);
    expect(secretOf(await (await w.req('/my/account/2fa', { sid })).text())).toBeNull();
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(0);
    await w.req('/my/account/2fa/start', { sid, method: 'POST' });
    const s2 = secretOf(await (await w.req('/my/account/2fa', { sid })).text())!;
    remember(s2);
    tick(601);
    expect((await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(s2) } })).status).toBe(400);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).toBeNull();
  });

  it('세션이 지워지면(로그아웃) 등록 대기도 지워진다 (ON DELETE CASCADE)', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    await w.req('/my/account/2fa/start', { sid, method: 'POST' });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(1);
    await w.req('/logout', { sid, method: 'POST' });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(0);
  });
});

describe.skipIf(!hasDb)('로그인: 2단계 인증을 켠 회원', () => {
  it('이메일 단계의 응답은 2단계 인증 여부와 같다', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    remember((await enable(w, sid)).secret);
    const a = await w.req('/login/request', { form: { email: EMAILS.s1, role: 'seeker' } });
    const b = await w.req('/login/request', { form: { email: EMAILS.s2, role: 'seeker' } });
    expect(a.status).toBe(b.status);
    expect([...a.headers.keys()].sort()).toEqual([...b.headers.keys()].sort());
    expect((await a.text()).replaceAll(EMAILS.s1, 'X')).toBe((await b.text()).replaceAll(EMAILS.s2, 'X'));
  });

  it('인증코드 뒤에는 세션 없이 2단계 → 번호를 맞히면 mfa = 1 세션. 같은 번호는 다시 받지 않는다', async () => {
    const w = world();
    const { secret } = await enable(w, await w.session('s1', 0));
    w.raw.prepare('DELETE FROM sessions').run();
    tick();
    const { res } = await emailLogin(w, EMAILS.s1);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login/totp');
    expect(cookieOf(res, 'sid')).toBeNull();
    const atp = cookieOf(res, 'atp')!;
    expect(w.n('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
    const page = await w.req('/login/totp', { atp });
    expect(page.headers.get('cache-control')).toBe(NO_STORE);
    const html = await page.text();
    expect(html).toContain('<h1>2단계 인증</h1>');
    expect(html).toContain('복구 코드');
    expect(html).toContain('운영자에게 연락');
    expect(html).not.toContain('class="secret"');
    // 아직 세션이 없으므로 로그인 화면으로
    expect((await w.req('/my/account')).headers.get('location')).toBe('/login');
    const c = await w.code(secret);
    const ok = await w.req('/login/totp', { atp, form: { code: c } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/my');
    const sid = cookieOf(ok, 'sid')!;
    expect(w.one('SELECT mfa FROM sessions')!.mfa).toBe(1);
    expect((await w.req('/my/account', { sid })).status).toBe(200);
    // 같은 30초 안에 다시 로그인해 같은 번호 → 거부
    const again = cookieOf((await emailLoginAfter(w, EMAILS.s1)).res, 'atp')!;
    const r2 = await w.req('/login/totp', { atp: again, form: { code: c } });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('번호가 맞지 않습니다');
    expect(w.n('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
  });

  it('2단계에서 5번 틀리면 대기가 지워져 로그인부터 다시', async () => {
    const w = world();
    remember((await enable(w, await w.session('s1', 0))).secret);
    const atp = cookieOf((await emailLogin(w, EMAILS.s1)).res, 'atp')!;
    for (let i = 0; i < 4; i++) expect((await w.req('/login/totp', { atp, form: { code: 'AAAAA-AAAAA' } })).status).toBe(200);
    const last = await w.req('/login/totp', { atp, form: { code: '000000' } });
    expect(last.status).toBe(302);
    expect(last.headers.get('location')).toBe('/login');
    expect(w.n('SELECT COUNT(*) AS n FROM admin_totp_pending')).toBe(0);
  });

  it('복구 코드: 정규화해 받고, 한 번만 쓰이고, 알림 메일 + 재등록 안내', async () => {
    const w = world();
    const { codes } = await enable(w, await w.session('s1', 0));
    w.raw.prepare('DELETE FROM sessions').run();
    const atp = cookieOf((await emailLogin(w, EMAILS.s1)).res, 'atp')!;
    const typed = ` ${codes[0]!.toLowerCase().replace('-', ' - ')} `;
    const ok = await w.req('/login/totp', { atp, form: { code: typed } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe(NO_STORE);
    const html = await ok.text();
    expect(html).toContain('복구 코드로 로그인했습니다');
    expect(html).toContain('7개');
    expect(html).toContain('/my/account/2fa');
    expect(cookieOf(ok, 'sid')).not.toBeNull();
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE used_at IS NOT NULL')).toBe(1);
    expect(mails().filter((m) => m.template === 'totp_recovery_used')).toHaveLength(1);
    // 같은 코드는 다시 안 된다
    tick(61);
    const atp2 = cookieOf((await emailLogin(w, EMAILS.s1)).res, 'atp')!;
    const r2 = await w.req('/login/totp', { atp: atp2, form: { code: codes[0]! } });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('번호가 맞지 않습니다');
    expect(w.n('SELECT COUNT(*) AS n FROM sessions')).toBe(1);
  });

  it('같은 복구 코드를 동시에 두 번 써도 하나만 통과한다 (한 문장 가드)', async () => {
    const w = world();
    const { codes } = await enable(w, await w.session('s1', 0));
    const h = await recoveryHash(PEPPER, 's1', codes[1]!.replace('-', ''));
    const rs = await Promise.all([useRecoveryCode(w.db, 's1', h, clock), useRecoveryCode(w.db, 's1', h, clock)]);
    expect(rs.filter(Boolean)).toHaveLength(1);
    // 남의 계정 id 로는 쓸 수 없다
    const h3 = await recoveryHash(PEPPER, 's1', codes[2]!.replace('-', ''));
    expect(await useRecoveryCode(w.db, 's2', h3, clock)).toBe(false);
  });

  it('유형 안내는 그대로: 2단계 없는 계정과 2단계를 켠 계정 모두 다른 유형을 고르면 안내', async () => {
    const w = world();
    const plain = (await emailLogin(w, EMAILS.s2, 'company')).res;
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain('구직자');
    expect(cookieOf(plain, 'sid')).not.toBeNull();
    const same = (await emailLogin(w, EMAILS.co, 'company')).res;
    expect(same.status).toBe(302);
    expect(same.headers.get('location')).toBe('/my');
    const { secret } = await enable(w, await w.session('s1', 0));
    tick();
    const atp = cookieOf((await emailLogin(w, EMAILS.s1, 'company')).res, 'atp')!;
    const r = await w.req('/login/totp', { atp, form: { code: await w.code(secret) } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(plainNoticeTitle);
  });

  it('2단계 인증을 켠 계정의 mfa = 0 세션은 로그인하지 않은 것으로 본다', async () => {
    const w = world();
    remember((await enable(w, await w.session('s1', 0))).secret);
    const weak = await w.session('s1', 0);
    const r = await w.req('/my/account', { sid: weak });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login');
    expect((await w.req('/my', { sid: weak })).headers.get('location')).toBe('/login');
  });
});

const plainNoticeTitle = '<h1>로그인했습니다</h1>';

/** 같은 30초 안에 다시 로그인한다 (맞힌 인증코드 행은 지워지므로 재발송 간격에 걸리지 않는다). */
const emailLoginAfter = (w: W, email: string) => emailLogin(w, email);

describe.skipIf(!hasDb)('회원: 끄기·복구 코드 새로 만들기·시도 한도', () => {
  it('끄려면 번호나 복구 코드가 필요하다 (세션만으로는 안 됨)', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { secret } = await enable(w, sid);
    const g = await w.req('/my/account/2fa/off', { sid });
    expect(g.status).toBe(200);
    expect(g.headers.get('cache-control')).toBe(NO_STORE);
    expect((await w.req('/my/account/2fa/off', { sid, form: {} })).status).toBe(400);
    expect((await w.req('/my/account/2fa/off', { sid, form: { code: '000000' } })).status).toBe(400);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).not.toBeNull();
    tick();
    const ok = await w.req('/my/account/2fa/off', { sid, form: { code: await w.code(secret) } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/my/account/2fa?ok=off');
    const u = w.one('SELECT totp_secret, totp_last_step, totp_enabled_at FROM users WHERE id = ?', 's1')!;
    expect(u).toEqual({ totp_secret: null, totp_last_step: null, totp_enabled_at: null });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes')).toBe(0);
    expect(mails().filter((m) => m.template === 'totp_disabled')).toHaveLength(1);
    // 끈 뒤에는 이메일 인증코드만으로 로그인
    const r = (await emailLogin(w, EMAILS.s1)).res;
    expect(r.headers.get('location')).toBe('/my');
  });

  it('복구 코드로도 끌 수 있다', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { codes } = await enable(w, sid);
    expect((await w.req('/my/account/2fa/off', { sid, form: { code: codes[3]! } })).status).toBe(303);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).toBeNull();
  });

  it('15분에 5번 틀리면 잠긴다 (맞는 번호도 받지 않음) → 창이 지나면 다시', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { secret } = await enable(w, sid);
    for (let i = 0; i < 5; i++) expect(await (await w.req('/my/account/2fa/off', { sid, form: { code: '111111' } })).text()).toContain('맞지 않습니다');
    tick();
    const locked = await w.req('/my/account/2fa/off', { sid, form: { code: await w.code(secret) } });
    expect(locked.status).toBe(400);
    expect(await locked.text()).toContain('15분 뒤');
    // 잠긴 동안은 번호를 쓰지 않았다 → 그 단계는 아직 쓸 수 있다
    expect(w.one('SELECT totp_last_step FROM users WHERE id = ?', 's1')!.totp_last_step).toBe(Math.floor(T0 / 30));
    expect((await w.req('/my/account/2fa/codes', { sid, form: { code: await w.code(secret) } })).status).toBe(400);
    tick(15 * 60);
    expect((await w.req('/my/account/2fa/off', { sid, form: { code: await w.code(secret) } })).status).toBe(303);
    expect(w.one('SELECT totp_fail_count AS n FROM users WHERE id = ?', 's1')!.n).toBe(0);
  });

  it('복구 코드 새로 만들기: 인증 앱 번호가 필요하고(복구 코드로는 안 됨) 예전 코드는 무효', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { secret, codes } = await enable(w, sid);
    expect((await w.req('/my/account/2fa/codes', { sid, form: { code: codes[0]! } })).status).toBe(400);
    tick();
    const r = await w.req('/my/account/2fa/codes', { sid, form: { code: await w.code(secret) } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(NO_STORE);
    const fresh = codesOf(await r.text());
    remember(...fresh);
    expect(fresh).toHaveLength(8);
    expect(fresh.some((c) => codes.includes(c))).toBe(false);
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ?', 's1')).toBe(8);
    expect(await useRecoveryCode(w.db, 's1', await recoveryHash(PEPPER, 's1', codes[1]!.replace('-', '')), clock)).toBe(false);
    expect(mails().filter((m) => m.template === 'totp_codes_new')).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)('관리자', () => {
  it('최초 등록(로그인)에서 복구 코드 8개를 한 번 보여 준다', async () => {
    const w = world();
    const atp = cookieOf((await emailLogin(w, EMAILS.adm2)).res, 'atp')!;
    const page = await w.req('/login/totp', { atp });
    expect(page.headers.get('cache-control')).toBe(NO_STORE);
    const html = await page.text();
    expect(html).toContain('관리자 2단계 인증');
    const secret = secretOf(html)!;
    remember(secret);
    const ok = await w.req('/login/totp', { atp, form: { code: await w.code(secret) } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe(NO_STORE);
    const okHtml = await ok.text();
    const codes = codesOf(okHtml);
    remember(...codes);
    expect(codes).toHaveLength(8);
    expect(okHtml).toContain('href="/admin"');
    expect(okHtml).toContain('저장했습니다 → 계속');
    expect(cookieOf(ok, 'sid')).not.toBeNull();
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ?', 'adm2')).toBe(8);
    expect(w.one('SELECT mfa FROM sessions WHERE user_id = ?', 'adm2')!.mfa).toBe(1);
    // 그다음 로그인은 복구 코드로도 된다
    tick(61);
    const atp2 = cookieOf((await emailLogin(w, EMAILS.adm2)).res, 'atp')!;
    const r2 = await w.req('/login/totp', { atp: atp2, form: { code: codes[0]! } });
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('href="/admin"');
  });

  it('끌 수 없다: 화면도 POST 도 403, 계정 화면에 끄기 링크 없음', async () => {
    const w = world();
    const { secret, sid } = await adminWithSecret(w);
    expect((await w.req('/my/account/2fa/off', { sid })).status).toBe(403);
    expect((await w.req('/my/account/2fa/off', { sid, form: { code: await w.code(secret) } })).status).toBe(403);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 'adm')!.totp_secret).not.toBeNull();
    const html = await (await w.req('/my/account/2fa', { sid })).text();
    expect(html).not.toContain('/my/account/2fa/off');
    expect(html).toContain('인증 앱 다시 등록');
  });

  it('재등록: 1단계(지금 번호) → 새 키 → 새 번호로 확정. 확정 전까지 예전 키 그대로, 확정하면 복구 코드 교체·다른 세션 삭제', async () => {
    const w = world();
    const { secret: oldSecret, sid } = await adminWithSecret(w);
    const other = await w.session('adm', 1);
    const oldEnc = w.one('SELECT totp_secret FROM users WHERE id = ?', 'adm')!.totp_secret;
    // 1단계 없이는 새 키가 나오지 않는다
    expect((await w.req('/my/account/2fa/start', { sid, method: 'POST' })).status).toBe(303);
    expect(secretOf(await (await w.req('/my/account/2fa', { sid })).text())).toBeNull();
    expect((await w.req('/my/account/2fa/reenrol', { sid, form: { code: '000000' } })).status).toBe(400);
    expect(secretOf(await (await w.req('/my/account/2fa', { sid })).text())).toBeNull();
    tick();
    expect((await w.req('/my/account/2fa/reenrol', { sid, form: { code: await w.code(oldSecret) } })).status).toBe(303);
    const page = await (await w.req('/my/account/2fa', { sid })).text();
    const newSecret = secretOf(page)!;
    remember(newSecret);
    expect(newSecret).not.toBe(oldSecret);
    expect(page).toContain('예전 인증 앱의 번호도 그대로');
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 'adm')!.totp_secret).toBe(oldEnc);
    // 확정 전: 예전 키로 로그인 가능
    tick();
    const atp = cookieOf((await emailLogin(w, EMAILS.adm)).res, 'atp')!;
    expect((await w.req('/login/totp', { atp, form: { code: await w.code(oldSecret) } })).headers.get('location')).toBe('/admin');
    // 예전 키의 번호로는 확정되지 않는다
    tick();
    expect((await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(oldSecret) } })).status).toBe(400);
    const r = await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(newSecret) } });
    expect(r.status).toBe(200);
    const codes = codesOf(await r.text());
    remember(...codes);
    expect(codes).toHaveLength(8);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 'adm')!.totp_secret).not.toBe(oldEnc);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', 'adm')).toBe(1);
    expect((await w.req('/admin', { sid })).status).toBe(200);
    expect((await w.req('/admin', { sid: other })).headers.get('location')).toBe('/login');
    expect(mails().filter((m) => m.template === 'totp_reenrolled')).toHaveLength(1);
    // 확정 뒤: 예전 키로는 로그인 안 됨
    tick();
    const atp2 = cookieOf((await emailLoginAfter(w, EMAILS.adm)).res, 'atp')!;
    expect((await w.req('/login/totp', { atp: atp2, form: { code: await w.code(oldSecret) } })).status).toBe(200);
  });

  it('회원 2단계 인증 초기화: 사유 10자 이상 → 확인 → 기록·세션 삭제·알림. 관리자 계정은 대상이 아니다', async () => {
    const w = world();
    const { sid } = await adminWithSecret(w);
    const ssid = await w.session('s1', 0);
    remember((await enable(w, ssid)).secret);
    await w.session('s1', 1);
    const g = await w.req('/admin/users/2fa-reset', { sid });
    expect(g.status).toBe(200);
    expect(g.headers.get('cache-control')).toBe(NO_STORE);
    // 회원·비로그인은 못 연다 (그래도 no-store)
    const asMember = await w.req('/admin/users/2fa-reset', { sid: ssid });
    expect(asMember.status).toBe(403);
    expect(asMember.headers.get('cache-control')).toBe(NO_STORE);
    // 다른 출처의 POST 는 거부
    const cross = await app.fetch(new Request(`${ORIGIN}/admin/users/2fa-reset/confirm`, {
      method: 'POST', headers: { cookie: `sid=${sid}`, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: EMAILS.s1, reason: '휴대폰 분실 확인함 전화' }),
    }) as never, w.env);
    expect(cross.status).toBe(403);

    const short = await w.req('/admin/users/2fa-reset', { sid, form: { email: EMAILS.s1, reason: '분실' } });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain('10자 이상');
    expect((await w.req('/admin/users/2fa-reset/confirm', { sid, form: { email: EMAILS.s1, reason: '짧음' } })).status).toBe(400);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).not.toBeNull();
    expect(await (await w.req('/admin/users/2fa-reset', { sid, form: { email: 'nobody@example.test', reason: '휴대폰 분실, 전화로 본인 확인' } })).text()).toContain('회원이 없습니다');
    expect(await (await w.req('/admin/users/2fa-reset', { sid, form: { email: EMAILS.s2, reason: '휴대폰 분실, 전화로 본인 확인' } })).text()).toContain('켜지 않았습니다');
    const adminTarget = await w.req('/admin/users/2fa-reset/confirm', { sid, form: { email: EMAILS.adm, reason: '휴대폰 분실, 전화로 본인 확인' } });
    expect(adminTarget.status).toBe(400);
    expect(await adminTarget.text()).toContain('운영자 계정은');
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 'adm')!.totp_secret).not.toBeNull();

    const reason = '휴대폰 분실, 전화로 본인 확인 완료';
    const confirm = await w.req('/admin/users/2fa-reset', { sid, form: { email: ` ${EMAILS.s1.toUpperCase()} `, reason } });
    expect(confirm.status).toBe(200);
    const ch = await confirm.text();
    expect(ch).toContain(EMAILS.s1);
    expect(ch).toContain('/admin/users/2fa-reset/confirm');
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).not.toBeNull();
    const done = await w.req('/admin/users/2fa-reset/confirm', { sid, form: { email: EMAILS.s1, reason } });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/users/2fa-reset?ok=1');
    expect(w.one('SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?', 's1')).toEqual({ totp_secret: null, totp_enabled_at: null });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ?', 's1')).toBe(0);
    expect(w.n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', 's1')).toBe(0);
    expect(w.one('SELECT actor_id, action, target_user_id, reason, at FROM admin_actions')).toEqual({ actor_id: 'adm', action: 'totp_reset', target_user_id: 's1', reason, at: clock });
    const m = mails().filter((x) => x.template === 'totp_reset_by_admin');
    expect(m).toHaveLength(1);
    expect(m[0]!.to).toBe(EMAILS.s1);
    expect(m[0]!.text).not.toContain(reason);
    // 두 번 눌러도 기록은 하나
    expect((await w.req('/admin/users/2fa-reset/confirm', { sid, form: { email: EMAILS.s1, reason } })).status).toBe(400);
    expect(w.n('SELECT COUNT(*) AS n FROM admin_actions')).toBe(1);
    expect(await (await w.req('/admin', { sid })).text()).toContain('/admin/users/2fa-reset');
  });
});

/** 관리자(adm)에게 계정 화면과 같은 방법으로 비밀키를 넣고 mfa = 1 세션을 준다. */
async function adminWithSecret(w: W) {
  const sid = await w.session('adm', 1);
  expect((await w.req('/my/account/2fa/start', { sid, method: 'POST' })).status).toBe(303);
  const secret = secretOf(await (await w.req('/my/account/2fa', { sid })).text())!;
  const r = await w.req('/my/account/2fa/confirm', { sid, form: { code: await w.code(secret) } });
  expect(r.status).toBe(200);
  remember(secret, ...codesOf(await r.text()));
  tick();
  return { secret, sid };
}

describe.skipIf(!hasDb)('정리 작업·탈퇴', () => {
  it('dropOldRows: 만료된 등록 대기, 쓴 복구 코드, 2단계 인증이 꺼진 계정의 복구 코드, 오래된 관리자 기록', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { codes } = await enable(w, sid);
    await useRecoveryCode(w.db, 's1', await recoveryHash(PEPPER, 's1', codes[0]!.replace('-', '')), clock);
    const sid2 = await w.session('s2', 0);
    await w.req('/my/account/2fa/start', { sid: sid2, method: 'POST' });
    remember(secretOf(await (await w.req('/my/account/2fa', { sid: sid2 })).text()));
    w.raw.prepare("INSERT INTO totp_recovery_codes (id, user_id, code_hash, created_at) VALUES ('orphan', 's2', 'h', 0)").run();
    w.raw.prepare("INSERT INTO admin_actions (id, actor_id, action, target_user_id, reason, at) VALUES ('old', 'adm', 'totp_reset', 's2', '오래된 기록입니다 열자', 0), ('new', 'adm', 'totp_reset', 's2', '최근 기록입니다 열자', ?)").run(clock);
    const r0 = await STEPS.dropOldRows(w.env, clock);
    expect(r0.done).toMatchObject({ totp_enrolments: 0, totp_recovery_codes: 2, admin_actions: 1 });
    tick(601);
    const r1 = await STEPS.dropOldRows(w.env, clock);
    expect(r1.done).toMatchObject({ totp_enrolments: 1, totp_recovery_codes: 0, admin_actions: 0 });
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes')).toBe(7);
    expect(w.n("SELECT COUNT(*) AS n FROM admin_actions WHERE id = 'new'")).toBe(1);
  });

  it('탈퇴: 비밀키는 지워지고 등록 대기는 세션과 함께 지워진다. 복구 코드도 함께 지워진다', async () => {
    const w = world();
    const sid = await w.session('s1', 0);
    const { codes } = await enable(w, sid);
    expect((await w.req('/my/account/2fa/reenrol', { sid, form: { code: codes[0]! } })).status).toBe(303);
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(1);
    const r = await deleteAccount(w.env, { id: 's1', email: EMAILS.s1, role: 'seeker', locale: 'ko' });
    expect(r.ok).toBe(true);
    expect(w.one('SELECT totp_secret FROM users WHERE id = ?', 's1')!.totp_secret).toBeNull();
    expect(w.n('SELECT COUNT(*) AS n FROM totp_enrolments')).toBe(0);
    // 복구 코드도 탈퇴와 함께 바로 지워진다 (db/account.eraseUser).
    expect(w.n('SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ?', 's1')).toBe(0);
    expect(w.one('SELECT totp_last_step, totp_enabled_at FROM users WHERE id = ?', 's1')).toEqual({ totp_last_step: null, totp_enabled_at: null });
  });
});

describe.skipIf(!hasDb)('동의 확인·점검 모드의 예외 주소', () => {
  it('동의하지 않은 회원도 /my/account/2fa* 를 열 수 있고(lib/consent 의 /my/account 예외), /login/totp 는 점검 중에도 열린다', async () => {
    const { consentExempt } = await import('../src/lib/consent');
    const { maintenanceExempt } = await import('../src/lib/pause');
    for (const p of ['/my/account/2fa', '/my/account/2fa/start', '/my/account/2fa/confirm', '/my/account/2fa/off', '/login/totp']) expect(consentExempt(p), p).toBe(true);
    expect(maintenanceExempt('/login/totp')).toBe(true);
    expect(maintenanceExempt('/admin/users/2fa-reset')).toBe(true);
    const w = world();
    w.raw.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('nc', 'fake.tfa.noconsent@example.test', 'seeker', 'active', 0)").run();
    const sid = await w.session('nc' as Who, 0);
    expect((await w.req('/my/resumes', { sid })).headers.get('location')).toMatch(/^\/consent/);
    expect((await w.req('/my/account/2fa', { sid })).status).toBe(200);
  });
});
