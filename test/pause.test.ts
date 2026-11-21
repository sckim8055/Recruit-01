// 점검 모드 (T-13, src/lib/pause.ts + src/index.tsx) 와 /admin/system · /api/health. app.fetch 로 라우트 전체를 돈다.
// SQLite 메모리 DB, 가짜 R2, 가짜 Cache API(공개 화면 캐시와의 관계 확인). 모든 값은 가짜다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { b64url, sha256Hex } from '../src/lib/crypto';
import { isMaintenanceOn, maintenanceBlocks, maintenanceExempt } from '../src/lib/pause';
import { agreeRequired } from './consent-fixture';
import { hasSqlite, migratedDb } from './sqlite-d1';

const ENC_KEY = b64url(new Uint8Array(32).fill(5)).replace(/-/g, '+').replace(/_/g, '/');
const PEPPER = 'fake-pepper-for-tests-0123';
const RESEND = 're_fake_key_for_system_page_test';
const ORIGIN = 'http://localhost';

type Who = 'seeker' | 'company' | 'admin' | 'admin_nomfa';

function world(vars: Record<string, string> = {}) {
  const { raw, d1 } = migratedDb();
  raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
    ('seeker','s@example.test','seeker','active',0), ('company','c@example.test','company','active',0),
    ('admin','a@example.test','admin','active',0), ('admin_nomfa','a2@example.test','admin','active',0)`);
  const env: Record<string, unknown> = {
    APP_ENV: 'test', APP_ORIGIN: 'https://recruit.example.test', DB: d1, FILES: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    ENC_KEY, SESSION_PEPPER: PEPPER, RESEND_API_KEY: RESEND, MAIL_FROM: 'Recruit <no-reply@x.test>', REGISTRATION_NO: '',
    OPERATOR_DOMAINS: 'x.test', FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off',
    ...vars,
  };
  const cookie = async (who: Who | null): Promise<Record<string, string>> => {
    if (!who) return { cookie: 'lang=ko' };
    const token = `tok-${who}`;
    raw.prepare('INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES (?,?,?,?,?)')
      .run(await sha256Hex(`${PEPPER}|${token}`), who, 0, 4_000_000_000, who === 'admin' ? 1 : 0);
    if (who !== 'admin' && who !== 'admin_nomfa') agreeRequired(raw, who);
    return { cookie: `sid=${token}; lang=ko` };
  };
  const get = async (path: string, who: Who | null = null, lang?: string) => {
    const h = await cookie(who);
    if (lang) h.cookie = (h.cookie ?? '').replace('lang=ko', `lang=${lang}`);
    return app.fetch(new Request(`${ORIGIN}${path}`, { headers: h }) as never, env as never);
  };
  return { raw, env, get };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('점검 모드 판단 (순수 함수)', () => {
  it('"on" 일 때만 켜진다', () => {
    expect([isMaintenanceOn('on'), isMaintenanceOn(' ON '), isMaintenanceOn('off'), isMaintenanceOn(''), isMaintenanceOn(undefined), isMaintenanceOn('1')])
      .toEqual([true, true, false, false, false, false]);
  });
  it('관리자·로그인·health·정적 파일만 통과', () => {
    for (const p of ['/api/health', '/login', '/login/request', '/login/verify', '/login/totp', '/logout', '/lang/zh', '/admin', '/admin/system', '/app.css']) {
      expect(maintenanceExempt(p)).toBe(true);
    }
    for (const p of ['/', '/jobs', '/jobs/1', '/my', '/biz', '/terms', '/privacy', '/consent', '/api/other', '/administrator', '/loginx']) {
      expect(maintenanceExempt(p)).toBe(false);
    }
    expect(maintenanceBlocks('on', 'admin', '/jobs')).toBe(false);
    expect(maintenanceBlocks('on', 'seeker', '/jobs')).toBe(true);
    expect(maintenanceBlocks('on', null, '/')).toBe(true);
    expect(maintenanceBlocks('off', null, '/')).toBe(false);
  });
});

describe.skipIf(!hasSqlite)('점검 모드 (라우트)', () => {
  it('켜면: 방문자·로그인한 구직자·기업 담당자는 503 (한·중), 관리자·health·로그인 화면은 그대로', async () => {
    const w = world({ MAINTENANCE: 'on' });
    for (const [path, who] of [['/', null], ['/jobs', null], ['/my', 'seeker'], ['/biz', 'company'], ['/privacy', null], ['/my/resumes', 'seeker']] as const) {
      const res = await w.get(path, who);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('retry-after')).toBe('1800');
      expect(await res.text()).toContain('점검 중입니다');
    }
    expect(await (await w.get('/jobs', null, 'zh')).text()).toContain('系统维护中');
    const admin = await w.get('/admin', 'admin');
    expect(admin.status).toBe(200);
    expect(await admin.text()).not.toContain('점검 중입니다');
    expect((await w.get('/jobs', 'admin')).status).toBe(200);
    expect(await (await w.get('/api/health')).json()).toEqual({ ok: true, env: 'test' });
    expect((await w.get('/login')).status).toBe(200);
    // TOTP 를 통과하지 않은 관리자 세션은 관리자로 인정되지 않는다 → 점검 안내
    expect((await w.get('/jobs', 'admin_nomfa')).status).toBe(503);
  });

  it('켜져 있는 동안 공개 화면 캐시를 읽지 않는다 (캐시에 화면이 있어도 503)', async () => {
    const match = vi.fn(async () => new Response('<p>CACHED PAGE</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const put = vi.fn(async () => undefined);
    vi.stubGlobal('caches', { default: { match, put } });
    const on = world({ MAINTENANCE: 'on' });
    const res = await on.get('/jobs');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('CACHED PAGE');
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    // 끄면 원래대로 캐시를 쓴다 (가짜 캐시가 동작하는지 확인)
    const off = world({ MAINTENANCE: 'off' });
    const hit = await off.get('/jobs');
    expect(await hit.text()).toContain('CACHED PAGE');
    expect(hit.headers.get('x-page-cache')).toBe('hit');
  });

  it('꺼져 있으면(off·없음) 아무 영향 없음', async () => {
    for (const v of [{ MAINTENANCE: 'off' }, {}] as Record<string, string>[]) {
      const w = world(v);
      expect((await w.get('/')).status).toBe(200);
    }
  });
});

describe.skipIf(!hasSqlite)('GET /admin/system (T-13)', () => {
  it('관리자(TOTP 통과)만: 점검 표·비밀값 유무·시간표·보관 기간, no-store, 비밀값은 보이지 않는다', async () => {
    const w = world();
    const res = await w.get('/admin/system', 'admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    for (const s of ['시스템 점검', '설정 점검', '비밀값', '예약 작업 시간표', '보관 기간', 'DB 마이그레이션', 'purgeApplications', '설정됨']) expect(html).toContain(s);
    for (const secret of [ENC_KEY, PEPPER, RESEND, ENC_KEY.slice(0, 8), PEPPER.slice(0, 8), RESEND.slice(0, 8)]) expect(html).not.toContain(secret);
    // test 서버 + 법률 표시 남음 → 확인 항목이 있다 (빨간 문제는 없음: 바인딩·키 모두 있음)
    expect(html).toContain('알아 둘 항목이 있습니다');
    // 중국어 화면
    expect(await (await w.get('/admin/system', 'admin', 'zh')).text()).toContain('系统检查');
  });

  it('관리자 아님: 403 · 비로그인: 로그인으로, 모두 no-store', async () => {
    const w = world();
    for (const who of ['seeker', 'company', 'admin_nomfa'] as const) {
      const r = await w.get('/admin/system', who);
      expect(r.status === 403 || r.status === 302, who).toBe(true);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(await r.text()).not.toContain('설정 점검');
    }
    const anon = await w.get('/admin/system');
    expect(anon.status).toBe(302);
    expect(anon.headers.get('cache-control')).toBe('private, no-store');
  });

  it('비밀값이 빠진 서버: 문제 표시, 그래도 화면은 뜬다 (요청을 막지 않음)', async () => {
    const w = world({ RESEND_API_KEY: '', SESSION_PEPPER: PEPPER, APP_ENV: 'production', MAIL_FROM: '' });
    const html = await (await w.get('/admin/system', 'admin')).text();
    expect(html).toContain('고쳐야 할 항목이 있습니다');
    expect(html).toContain('없음');
    expect((await w.get('/')).status).toBe(200);
  });

  it('/api/health 는 최소한만 (점검 결과 없음)', async () => {
    const w = world({ RESEND_API_KEY: '' });
    const res = await w.get('/api/health');
    expect(await res.json()).toEqual({ ok: true, env: 'test' });
  });

  it('관리자 첫 화면에서 연결된다', async () => {
    const w = world();
    expect(await (await w.get('/admin', 'admin')).text()).toContain('href="/admin/system"');
  });
});
