// 메일 발송 (src/lib/email.ts). T-13: 키가 없을 때 받는 주소·본문을 콘솔에 출력하는 것은 로컬 개발(APP_ENV = 'dev')뿐이다.
// 테스트·운영 서버에서는 출력하지 않고 실패(no_api_key)로 기록한다 — 배포된 서버의 콘솔은 Workers Logs 에 남기 때문이다. 모든 값은 가짜다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { sendMail } from '../src/lib/email';
import { hasSqlite, migratedDb } from './sqlite-d1';
import app from '../src/index';
import { b64url } from '../src/lib/crypto';

const MAIL = { to: 'someone@example.test', subject: '가짜 제목', text: '인증코드 123456', template: 'auth_code' };

function setup(appEnv: string, key?: string) {
  const { raw, d1 } = migratedDb();
  const env = { DB: d1, APP_ENV: appEnv, MAIL_FROM: 'Recruit <no-reply@x.test>', ...(key ? { RESEND_API_KEY: key } : {}) } as unknown as Env;
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const results = () => raw.prepare('SELECT result FROM email_log').all().map((r) => (r as { result: string }).result);
  return { env, logs, fetchMock, results, raw };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.skipIf(!hasSqlite)('sendMail: 키가 없을 때 (T-13)', () => {
  it('dev: 콘솔에 출력하고 성공으로 본다', async () => {
    const s = setup('dev');
    expect(await sendMail(s.env, MAIL)).toBe(true);
    expect(s.logs.join('\n')).toContain('[mail:auth_code] to=someone@example.test');
    expect(s.logs.join('\n')).toContain('123456');
    expect(s.results()).toEqual(['console']);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  for (const appEnv of ['test', 'production']) {
    it(`${appEnv}: 아무것도 출력하지 않고 실패(no_api_key)`, async () => {
      const s = setup(appEnv);
      expect(await sendMail(s.env, MAIL)).toBe(false);
      expect(s.logs).toEqual([]);
      expect(s.results()).toEqual(['no_api_key']);
      expect(s.fetchMock).not.toHaveBeenCalled();
    });
  }

  it('키가 있으면 환경과 관계없이 Resend 로 보내고 출력하지 않는다', async () => {
    const s = setup('test', 'fake-key');
    expect(await sendMail(s.env, MAIL)).toBe(true);
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    expect(s.logs).toEqual([]);
    expect(s.results()).toEqual(['sent']);
  });

  it('test 서버에 키가 없으면: 로그인 화면이 "메일을 보내지 못했습니다" 를 보이고 인증코드는 어디에도 출력되지 않는다', async () => {
    const s = setup('test');
    const env = {
      ...(s.env as unknown as Record<string, unknown>), APP_ORIGIN: 'http://localhost', SESSION_PEPPER: 'fake-pepper-0123456789',
      ENC_KEY: b64url(new Uint8Array(32).fill(3)), REGISTRATION_NO: '', FLAG_HEADHUNTER_POSTING: 'off',
    };
    const res = await app.fetch(new Request('http://localhost/login/request', {
      method: 'POST', headers: { origin: 'http://localhost', cookie: 'lang=ko' }, body: new URLSearchParams({ email: 'someone@example.test', role: 'seeker' }),
    }) as never, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('메일을 보내지 못했습니다');
    expect(s.logs.filter((l) => l.includes('[mail:') || l.includes('someone@example.test'))).toEqual([]);
    expect(s.results()).toEqual(['no_api_key']);
  });
});
