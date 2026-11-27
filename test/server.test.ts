// Node 서버 (T-19, src/server.ts · src/server-env.ts): 설정 읽기, 앞단(본문 크기 제한·정적 파일), 터널 뒤의 출처 검사(sameOrigin), 127.0.0.1 에서만 듣기.
import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { buildRoot, BODY_LIMIT_BYTES } from '../src/server';
import { ConfigError, DEFAULT_DATA_DIR, isInside, readServerConfig, startupLine } from '../src/server-env';
import { dataPaths } from '../scripts/lib/paths.mjs';
import { MAX_UPLOAD_BYTES } from '../src/lib/files';
import { RESUME_FILE_MAX_BYTES } from '../src/lib/resume-files';

const ORIGIN = 'https://recruit.kimbbob.xyz';
const BASE = {
  APP_ENV: 'test', APP_ORIGIN: ORIGIN, DATABASE_URL: 'postgres://recruit:fake-password-123@localhost:5433/recruit',
  ENC_KEY: 'k', SESSION_PEPPER: 'fake-pepper-0123456789', DATA_DIR: 'F:\\works\\Recruit-01-data',
};

describe('readServerConfig', () => {
  it('Windows 기본 폴더·포트·예약 작업·기능 플래그 기본 off', () => {
    const c = readServerConfig({ ...BASE, DATA_DIR: '' }, 'C:\\code\\recruit-01', 'win32');
    expect(c.port).toBe(8787);
    expect(c.filesDir).toBe('F:\\works\\Recruit-01-data\\files');
    expect(c.backupDir).toBe('F:\\works\\Recruit-01-data\\backups');
    expect(c.schedulerOn).toBe(true);
    expect(c.autoBackup).toBe(false);
    expect([c.env.FLAG_PAID_LABEL, c.env.FLAG_PRODUCTION_JOBS]).toEqual(['off', 'off']);
    expect(DEFAULT_DATA_DIR).toBe('F:\\works\\Recruit-01-data');
  });
  it('백업 스크립트의 폴더 규칙과 같다', () => {
    for (const pe of [{ ...BASE, DATA_DIR: '' }, { ...BASE, DATA_DIR: 'D:\\d', BACKUP_DIR: 'E:\\b' }]) {
      const c = readServerConfig(pe, 'C:\\code', 'win32');
      expect(dataPaths(pe, 'win32')).toMatchObject({ filesDir: c.filesDir, backupDir: c.backupDir });
    }
    const pe = { ...BASE, DATA_DIR: '/srv/recruit-data' };
    expect(dataPaths(pe, 'linux')).toMatchObject({ filesDir: readServerConfig(pe, '/code', 'linux').filesDir });
  });
  it('필수 값이 없거나 잘못되면 한국어 오류', () => {
    for (const bad of [{ APP_ENV: 'prod' }, { DATABASE_URL: '' }, { ENC_KEY: '' }, { APP_ORIGIN: '' }, { PORT: '80' }, { PORT: 'abc' }]) {
      expect(() => readServerConfig({ ...BASE, ...bad }, 'C:\\code', 'win32'), JSON.stringify(bad)).toThrow(ConfigError);
    }
    expect(() => readServerConfig({ ...BASE, DATA_DIR: '' }, '/code', 'linux')).toThrow('DATA_DIR');
  });
  it('데이터·백업 폴더가 코드 폴더 안이면 시작하지 않는다', () => {
    expect(() => readServerConfig({ ...BASE, DATA_DIR: '/code/recruit/data' }, '/code/recruit', 'linux')).toThrow('코드 폴더 안');
    expect(() => readServerConfig({ ...BASE, DATA_DIR: '/srv/d', BACKUP_DIR: '/code/recruit/backups' }, '/code/recruit', 'linux')).toThrow('BACKUP_DIR');
    expect([isInside('/a/b/c', '/a/b'), isInside('/a/b', '/a/b'), isInside('/a/bc', '/a/b'), isInside('/x', '/a')]).toEqual([true, true, false, false]);
  });
  it('자동 백업은 BACKUP_AUTO=on 이고 비밀문구가 12자 이상일 때만, SCHEDULER=off 는 끈다', () => {
    expect(readServerConfig({ ...BASE, BACKUP_AUTO: 'on', BACKUP_PASSPHRASE: 'short' }, 'C:\\code', 'win32').autoBackup).toBe(false);
    expect(readServerConfig({ ...BASE, BACKUP_AUTO: 'on', BACKUP_PASSPHRASE: 'long enough passphrase' }, 'C:\\code', 'win32').autoBackup).toBe(true);
    expect(readServerConfig({ ...BASE, SCHEDULER: 'off' }, 'C:\\code', 'win32').schedulerOn).toBe(false);
  });
  it('시작 로그 한 줄에 비밀값·접속 문자열이 없다', () => {
    const line = startupLine(readServerConfig({ ...BASE, RESEND_API_KEY: 're_fake_key' }, 'C:\\code', 'win32'));
    expect(line).toContain('listen=127.0.0.1:8787');
    for (const s of ['fake-password-123', 'fake-pepper', 're_fake_key', 'postgres://']) expect(line).not.toContain(s);
  });
});

describe('앞단 (buildRoot) + 터널 뒤의 출처 검사', () => {
  const env = {
    APP_ENV: 'test', APP_ORIGIN: ORIGIN, SESSION_PEPPER: 'fake-pepper-0123456789', ENC_KEY: '', REGISTRATION_NO: '', DB: {}, FILES: {},
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
  } as never;
  const root = buildRoot(env, resolve('public'));
  const post = (url: string, headers: Record<string, string>, body?: RequestInit["body"]) => root.fetch(new Request(url, { method: 'POST', headers, body }));

  it('요청 주소가 http://127.0.0.1:8787 이어도 브라우저 Origin 이 APP_ORIGIN 이면 통과, 다른 출처·없음은 403', async () => {
    const ok = await post('http://127.0.0.1:8787/logout', { origin: ORIGIN });
    expect(ok.status).toBe(302);
    expect((await post('http://127.0.0.1:8787/logout', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('http://127.0.0.1:8787/logout', {})).status).toBe(403);
    expect((await post('http://127.0.0.1:8787/logout', { origin: 'null' })).status).toBe(403);
    expect((await post('http://127.0.0.1:8787/logout', { origin: 'https://recruit.kimbbob.xyz.evil.example' })).status).toBe(403);
    // 터널이 Host 를 붙여 보내는 모양 (http://recruit.kimbbob.xyz/…) 도 통과
    expect((await post('http://recruit.kimbbob.xyz/logout', { origin: ORIGIN })).status).toBe(302);
    // Referrer-Policy 는 same-origin 그대로 (폼 전송의 Origin 이 "null" 이 되지 않게)
    expect(ok.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('본문 크기 제한: 사업자 서류(10MB)·이력서 첨부(5MB)는 들어가고, 그보다 훨씬 크면 413', async () => {
    expect(BODY_LIMIT_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(6 * 1024 * 1024);
    expect(RESUME_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
    const big = new Uint8Array(BODY_LIMIT_BYTES + 1);
    expect((await post('http://127.0.0.1:8787/logout', { origin: ORIGIN, 'content-type': 'application/octet-stream' }, big)).status).toBe(413);
  });

  it('public/ 정적 파일: app.css (text/css, 매번 확인), 없는 파일은 앱의 404', async () => {
    const css = await root.fetch(new Request('http://127.0.0.1:8787/app.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect((await root.fetch(new Request('http://127.0.0.1:8787/server.ts'))).status).toBe(404);
    expect((await root.fetch(new Request('http://127.0.0.1:8787/../package.json'))).status).toBe(404);
  });

  it('실제 HTTP 서버: 127.0.0.1 에서만 듣고, Host·Origin 이 터널과 같을 때 POST 가 통과', async () => {
    const server = serve({ fetch: (req) => root.fetch(req), hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => server.once('listening', r));
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe('127.0.0.1');
    const send = (headers: Record<string, string>) => new Promise<number>((res, rej) => {
      const r = request({ host: '127.0.0.1', port: addr.port, path: '/logout', method: 'POST', headers }, (resp) => { resp.resume(); res(resp.statusCode ?? 0); });
      r.on('error', rej);
      r.end();
    });
    try {
      expect(await send({ host: 'recruit.kimbbob.xyz', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' })).toBe(302);
      expect(await send({ host: 'recruit.kimbbob.xyz', origin: 'https://evil.example', 'x-forwarded-for': '1.2.3.4' })).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
