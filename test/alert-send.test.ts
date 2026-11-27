// T-10 조건 알림 보내기 (lib/alert-send.ts, 예약 작업 단계 sendAlerts) — SQLite 메모리 DB(외래키 켬 — D1 과 같게) + 가짜 Resend(fetch).
// 공개 조건(publicJobWhere)에 맞는 공고만, 새 공고만, 최신 순만 / 새 공고가 없으면 메일 없음 / 대상이 아닌 회원 / 상한·메일 몫 /
// 보낸 뒤에 기록·실패 수·자동 멈춤 / 야간·점검 / 메일에 이력서 없음 / 토큰은 해시만 / 정리·탈퇴 / 하위 요청 수. 모든 값은 가짜다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { sendAlerts } from '../src/lib/alert-send';
import { ALERT_MAX_FAILURES, ALERT_OPTIN_VERSION, ALERT_RUN_DEFAULT, nextDueAt } from '../src/lib/alerts';
import { runMaintenance } from '../src/lib/maintenance';
import { sha256Hex } from '../src/lib/crypto';
import { alertJobsSql, insertAlert } from '../src/db/alerts';
import { eraseUser } from '../src/db/account';
import { flagsOf } from '../src/env';
import { agreeRequired } from './consent-fixture';
import { hasDb, migratedDb } from './pg-test-db';
import type { Db, DbStatement } from '../src/db/types';

const KST = 9 * 3600;
const DAY = 86_400;
const kst = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000 - KST;
// 2027-01-18 (월) 09:00 KST = 00:00 UTC — 예약 작업이 매일 알림을 보내는 시각
const NOW = kst(2027, 1, 18, 9);
const ORIGIN = 'https://recruit.example.test';

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

type Raw = ReturnType<typeof migratedDb>['raw'];

// D1 호출 수 (prepare 의 first/all/run 한 번 = 1, batch 한 번 = 1 — 하위 요청 기준)
function counted(d1: Db) {
  const c = { calls: 0, statements: 0 };
  const db = {
    prepare(sql: string) {
      const s = d1.prepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const m of ['first', 'all', 'run'] as const) {
        const orig = s[m]!.bind(s);
        s[m] = (...a: unknown[]) => { c.calls++; c.statements++; return orig(...a); };
      }
      return s;
    },
    batch(stmts: unknown[]) { c.calls++; c.statements += stmts.length; return d1.batch(stmts as DbStatement[]); },
  } as unknown as Db;
  return { db, c };
}

interface Sent { to: string; subject: string; text: string; headers?: Record<string, string> }

function setup(vars: Record<string, string> = {}) {
  const { raw, d1 } = migratedDb();
  // (T-19) 외래키는 PostgreSQL 에서 항상 검사된다 — 예전의 PRAGMA foreign_keys = ON 은 필요 없다.
  const cnt = counted(d1);
  const r2 = { ops: 0 };
  const FILES = {
    list: async () => { r2.ops++; return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    delete: async () => { r2.ops++; },
  };
  const env = {
    DB: cnt.db, FILES, APP_ENV: 'test', APP_ORIGIN: ORIGIN, MAIL_FROM: 'Recruit <no-reply@x.test>', RESEND_API_KEY: 'fake-key',
    FLAG_PRODUCTION_JOBS: 'off', FLAG_HEADHUNTER_POSTING: 'off', FLAG_RESUME_ZH_SUMMARY: 'off', FLAG_PAID_LABEL: 'off', OPS_EMAIL: '', ...vars,
  } as unknown as Env;
  const sent: Sent[] = [];
  const mail = { fail: false, fetches: 0 };
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
    mail.fetches++;
    if (mail.fail) return new Response('{}', { status: 500 });
    const b = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
    sent.push({ to: b.to[0]!, subject: b.subject, text: b.text, headers: b.headers });
    return new Response('{}', { status: 200 });
  }));
  // 항목 (근무지 서울·부산, 사용 종료 인천)
  raw.exec("DELETE FROM job_options WHERE kind = 'location'");
  raw.exec(`INSERT INTO job_options (kind, code, label_ko, label_zh, sort, active, created_at, updated_at) VALUES
    ('location','seoul','서울','首尔',10,1,0,0), ('location','busan','부산','釜山',20,1,0,0), ('location','incheon','인천','仁川',30,0,0,0)`);
  // 기업: 검증 완료 c1(대표 owner), 미검증 c2
  raw.exec("INSERT INTO users (id, email, role, status, created_at) VALUES ('owner','fake.owner@example.test','company','active',0)");
  raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0), ('c2','미검증상사','kr_entity','pending',0)`);
  raw.exec("INSERT INTO company_members (company_id, user_id, member_role, created_at) VALUES ('c1','owner','owner',0)");
  return { raw, env, cnt, sent, mail, r2 };
}

function seeker(raw: Raw, o: { status?: string; role?: string; locale?: string; consent?: boolean } = {}): { id: string; email: string } {
  const id = uid();
  const email = `fake.${id.slice(-4)}@example.test`;
  raw.prepare('INSERT INTO users (id, email, role, locale, status, created_at) VALUES (?,?,?,?,?,0)')
    .run(id, email, o.role ?? 'seeker', o.locale ?? 'ko', o.status ?? 'active');
  if (o.consent !== false) agreeRequired(raw, id);
  return { id, email };
}

function job(raw: Raw, o: {
  co?: string; status?: string; published?: number | null; closes?: number | null; location?: string | null; chinese?: string | null;
  agency?: boolean; family?: string; namePublic?: number; title?: string;
} = {}): string {
  const id = uid();
  if (o.agency) raw.exec("INSERT INTO agencies (id, name, verify_status, created_at) VALUES ('ag1','가짜헤드','verified',0) ON CONFLICT DO NOTHING");
  raw.prepare(
    `INSERT INTO jobs (id, company_id, agency_id, created_by, job_family, title_ko, body_ko, localize_status, status, published_at, closes_at, location, chinese_level,
                       company_name_public, created_at, updated_at)
     VALUES (?,?,?,'owner',?,?,'본문','approved',?,?,?,?,?,?,0,0)`,
  ).run(id, o.co ?? 'c1', o.agency ? 'ag1' : null, o.family ?? 'office', o.title ?? `공고 ${id.slice(-4)}`, o.status ?? 'published',
    o.published === undefined ? NOW - 3600 : o.published, o.closes ?? null, o.location === undefined ? 'seoul' : o.location, o.chinese ?? null, o.namePublic ?? 1);
  return id;
}

async function alert(raw: Raw, env: Env, seekerId: string, filter: Record<string, string>, o: { freq?: 'daily' | 'weekly'; created?: number } = {}): Promise<string> {
  const id = uid();
  const created = o.created ?? NOW - 2 * DAY;
  const freq = o.freq ?? 'daily';
  const keys = ['chinese_level', 'role_category', 'industry', 'entry_stage', 'salary_basis', 'report_line', 'location'];
  const ordered = Object.fromEntries(keys.filter((k) => k in filter).map((k) => [k, filter[k]]));
  expect(await insertAlert(env.DB, {
    id, seekerId, filterJson: JSON.stringify(ordered), frequency: freq, now: created, nextDue: nextDueAt(freq, created), optinVersion: ALERT_OPTIN_VERSION, max: 5,
  })).toBe('ok');
  // 차례가 지났게
  raw.prepare('UPDATE alerts SET next_due_at = ? WHERE id = ?').run(NOW - 60, id);
  return id;
}

const row = (raw: Raw, id: string) => ({ ...raw.prepare('SELECT * FROM alerts WHERE id = ?').get(id) }) as Record<string, number | string | null>;
const n = (raw: Raw, sql: string, ...a: unknown[]) => Number(Object.values(raw.prepare(sql).get(...(a as never[])) ?? { n: 0 })[0]);

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.skipIf(!hasDb)('보낼 공고: 공개 조건 + 새 공고 + 같은 조건, 최신 순만', () => {
  it('/jobs 에 보이는 새 공고만 메일에 나온다 (미검증 기업·마감·차단·초안·지난 마감일·헤드헌터·생산직·다른 조건·예전 공고 제외)', async () => {
    const { raw, env, sent } = setup();
    const s = seeker(raw);
    const a = await alert(raw, env, s.id, { location: 'seoul' });
    const created = Number(row(raw, a).checked_until);
    const ok1 = job(raw, { published: NOW - 7200, title: '보이는 공고 하나' });
    const ok2 = job(raw, { published: NOW - 3600, namePublic: 0, title: '기업명 비공개 공고' });
    const bad = [
      job(raw, { co: 'c2', title: '미검증 기업' }), job(raw, { status: 'closed', title: '마감' }), job(raw, { status: 'blocked', title: '차단' }),
      job(raw, { status: 'draft', published: null, title: '초안' }), job(raw, { closes: NOW - 1, title: '마감일 지남' }), job(raw, { agency: true, title: '헤드헌터' }),
      job(raw, { family: 'production', title: '생산직' }), job(raw, { location: 'busan', title: '부산 공고' }), job(raw, { location: null, title: '근무지 없음' }),
      job(raw, { published: created - 1, title: '알림 전 공고' }), job(raw, { published: created, title: '알림 만든 초' }),
    ];
    expect(bad).toHaveLength(11);
    const r = await sendAlerts(env, NOW);
    expect(r.done).toMatchObject({ due: 1, sent: 1, failed: 0, no_news: 0 });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe(s.email);
    expect(m.subject).toBe('조건에 맞는 새 공고 2건');
    // 최신 게재 순: 비공개(NOW-3600) → 하나(NOW-7200)
    expect(m.text.indexOf('기업명 비공개 공고')).toBeLessThan(m.text.indexOf('보이는 공고 하나'));
    expect(m.text).toContain(`/jobs/${ok1}`);
    expect(m.text).toContain(`/jobs/${ok2}`);
    for (const t of ['미검증', '마감\n', '차단', '초안', '마감일 지남', '헤드헌터', '생산직', '부산 공고', '근무지 없음', '알림 전 공고', '알림 만든 초', '미검증상사']) {
      expect(m.text, t).not.toContain(t);
    }
    expect(m.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/recruit\.example\.test\/alerts\/u\/[A-Za-z0-9_-]{43}>$/);
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('공고 SQL 의 정렬은 게재 최신 순(published_at DESC, id DESC) 하나뿐이다 — 다른 정렬 키 없음', () => {
    const q = alertJobsSql(flagsOf({ FLAG_PRODUCTION_JOBS: 'off' } as Env), NOW, { location: 'seoul', chinese_level: 'business' }, 0, NOW, 10);
    expect(q.sql.match(/ORDER BY/g)).toHaveLength(1);
    expect(q.sql).toMatch(/ORDER BY j\.published_at DESC, j\.id DESC LIMIT \?\s*$/);
    expect(q.sql).not.toMatch(/resume|application|seeker|score|rank|random/i);
    expect(q.binds).toEqual([NOW, 'business', 'seoul', 0, NOW, 10]);
  });

  it('이 초(지금)에 게재된 공고는 다음 차례에 — 두 번 보내거나 빠뜨리지 않는다', async () => {
    const { raw, env, sent } = setup();
    const s = seeker(raw);
    const a = await alert(raw, env, s.id, { location: 'seoul' });
    job(raw, { published: NOW - 10, title: '앞 공고' });
    job(raw, { published: NOW, title: '이번 초 공고' });
    await sendAlerts(env, NOW);
    expect(sent[0]!.text).toContain('앞 공고');
    expect(sent[0]!.text).not.toContain('이번 초 공고');
    expect(row(raw, a).checked_until).toBe(NOW - 1);
    const next = Number(row(raw, a).next_due_at);
    expect(next).toBe(kst(2027, 1, 19, 9));
    await sendAlerts(env, next);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('이번 초 공고');
    expect(sent[1]!.text).not.toContain('앞 공고');
  });

  it('새 공고가 없으면 메일 없음: 차례·확인 기준만 넘기고 메일 몫·email_log 를 쓰지 않는다', async () => {
    const { raw, env, sent, mail } = setup();
    const s = seeker(raw);
    const a = await alert(raw, env, s.id, { location: 'busan' });
    job(raw, { location: 'seoul' });
    const r = await sendAlerts(env, NOW);
    expect(r.done).toMatchObject({ due: 1, sent: 0, no_news: 1 });
    expect(sent).toEqual([]);
    expect(mail.fetches).toBe(0);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM email_log')).toBe(0);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM usage_counters')).toBe(0);
    expect(row(raw, a)).toMatchObject({ next_due_at: kst(2027, 1, 19, 9), checked_until: NOW - 1, last_sent_at: null });
  });

  it('매주 알림: 보낸 뒤 다음 차례는 다음 월요일 09:00', async () => {
    const { raw, env } = setup();
    const s = seeker(raw);
    const a = await alert(raw, env, s.id, { location: 'seoul' }, { freq: 'weekly' });
    job(raw);
    await sendAlerts(env, NOW + 4 * 3600); // 13:00 KST 에 밀려 나가도
    expect(row(raw, a).next_due_at).toBe(kst(2027, 1, 25, 9));
  });
});

describe.skipIf(!hasDb)('받는 사람', () => {
  it('탈퇴·정지·동의 전·기업 계정·꺼진 알림·수신 동의 없는 행은 보내지 않고 차례도 그대로 둔다', async () => {
    const { raw, env, sent } = setup();
    job(raw);
    const ok = seeker(raw);
    const okA = await alert(raw, env, ok.id, { location: 'seoul' });
    const skip: string[] = [];
    for (const o of [{ status: 'deleted' }, { status: 'suspended' }, { consent: false }, { role: 'company' }]) {
      const u = seeker(raw, o);
      skip.push(await alert(raw, env, u.id, { location: 'seoul' }));
    }
    const p = seeker(raw);
    const paused = await alert(raw, env, p.id, { location: 'seoul' });
    raw.prepare("UPDATE alerts SET status = 'paused', paused_reason = 'user' WHERE id = ?").run(paused);
    const legacy = seeker(raw);
    const legacyA = await alert(raw, env, legacy.id, { location: 'seoul' });
    raw.prepare('UPDATE alerts SET optin_at = 0 WHERE id = ?').run(legacyA);
    // 옛 판의 동의만 있는 회원
    const old = seeker(raw, { consent: false });
    raw.prepare("INSERT INTO consents (id, user_id, type, version, agreed_at) VALUES (?,?,'terms','old',0), (?,?,'privacy','old',0)").run(`o1${old.id}`, old.id, `o2${old.id}`, old.id);
    skip.push(await alert(raw, env, old.id, { location: 'seoul' }));
    const r = await sendAlerts(env, NOW);
    expect(r.done).toMatchObject({ due: 1, sent: 1 });
    expect(sent.map((m) => m.to)).toEqual([ok.email]);
    expect(row(raw, okA).last_sent_at).toBe(NOW);
    // 탈퇴 계정의 알림은 같은 실행의 정리에서 지워진다 (메일 없이)
    expect(r.done.swept_deleted_users).toBe(1);
    expect(raw.prepare('SELECT id FROM alerts WHERE id = ?').get(skip[0]!)).toBeUndefined();
    for (const id of [...skip.slice(1), paused, legacyA]) expect(row(raw, id).next_due_at, id).toBe(NOW - 60);
  });

  it('메일에는 이력서·지원 기록이 없다, 로그에는 숫자만 (주소 없음)', async () => {
    const { raw, env, sent } = setup();
    const s = seeker(raw);
    const j = job(raw, { title: '평범한 공고' });
    raw.prepare("INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES (?,?, '가짜이력서제목', 1, 'v1.resumecipher.x', 'rfiles/fake-r', 0, 0)").run(uid(), s.id);
    raw.prepare("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, status, status_changed_at, created_at) VALUES (?,?,?, 'v1.snapcipher.y', 'submitted', 0, 0)").run(uid(), j, s.id);
    await alert(raw, env, s.id, { location: 'seoul' });
    const out = await runMaintenance(env, NOW, { force: 'sendAlerts' });
    expect(out.ok).toBe(true);
    expect(sent).toHaveLength(1);
    for (const w of ['가짜이력서제목', 'resumecipher', 'snapcipher', 'rfiles', '지원 완료', s.id]) expect(sent[0]!.text, w).not.toContain(w);
    expect(sent[0]!.text).toContain('평범한 공고'); // 지원한 공고도 조건에 맞으면 똑같이 나온다 (지원 기록을 보지 않는다)
    expect(logs.join('\n')).not.toMatch(/@|fake\.|seoul/);
    expect(logs.filter((l) => l.startsWith('maint:'))).toHaveLength(1);
  });

  it('중국어로 설정한 회원은 중국어 메일', async () => {
    const { raw, env, sent } = setup();
    const s = seeker(raw, { locale: 'zh' });
    await alert(raw, env, s.id, { location: 'seoul' });
    job(raw);
    await sendAlerts(env, NOW);
    expect(sent[0]!.subject).toBe('符合条件的新职位 1 个');
    expect(sent[0]!.text).toContain('工作地点：首尔');
  });
});

describe.skipIf(!hasDb)('상한·메일 몫', () => {
  it(`한 번에 ${ALERT_RUN_DEFAULT}개까지 (오래된 차례부터), 나머지는 다음 실행에`, async () => {
    const { raw, env, sent } = setup();
    job(raw);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = seeker(raw);
      const id = await alert(raw, env, s.id, { location: 'seoul' });
      raw.prepare('UPDATE alerts SET next_due_at = ? WHERE id = ?').run(NOW - 1000 + i, id); // i 가 작을수록 오래된 차례
      ids.push(id);
    }
    await sendAlerts(env, NOW);
    expect(sent).toHaveLength(ALERT_RUN_DEFAULT);
    for (const id of ids.slice(0, 8)) expect(row(raw, id).last_sent_at).toBe(NOW);
    for (const id of ids.slice(8)) expect(row(raw, id).last_sent_at).toBeNull();
    await sendAlerts(env, NOW + 4 * 3600);
    expect(sent).toHaveLength(12);
  });

  it('ALERT_SEND_PER_RUN 으로 줄일 수 있고 0 이면 보내지 않는다', async () => {
    for (const [v, want] of [['3', 3], ['0', 0]] as const) {
      const { raw, env, sent } = setup({ ALERT_SEND_PER_RUN: v });
      job(raw);
      for (let i = 0; i < 5; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
      await sendAlerts(env, NOW);
      expect(sent, v).toHaveLength(want);
      vi.unstubAllGlobals();
    }
  });

  it('하루 메일 몫(ALERT_MAIL_SITE_DAY)을 보내기 전에 잡고, 모자라면 그만큼만 보내고 멈춘다 — 나머지는 차례 그대로', async () => {
    const { raw, env, sent } = setup({ ALERT_MAIL_SITE_DAY: '2' });
    job(raw);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await alert(raw, env, seeker(raw).id, { location: 'seoul' }));
    const r1 = await sendAlerts(env, NOW);
    expect(r1.done).toMatchObject({ sent: 2, quota_stopped: 1 });
    expect(sent).toHaveLength(2);
    expect(n(raw, "SELECT n FROM usage_counters WHERE scope = 'alert_mail_site' AND subject = 'site'")).toBe(2);
    const r2 = await sendAlerts(env, NOW + 4 * 3600);
    expect(r2.done).toMatchObject({ sent: 0, quota_stopped: 1 });
    expect(sent).toHaveLength(2);
    expect(ids.filter((id) => row(raw, id).last_sent_at === null)).toHaveLength(3);
    for (const id of ids.filter((x) => row(raw, x).last_sent_at === null)) expect(row(raw, id).next_due_at).toBe(NOW - 60);
    // 다음 날(한국 시간)에는 새 몫
    const r3 = await sendAlerts(env, NOW + DAY);
    expect(r3.done).toMatchObject({ sent: 2 });
  });

  it('기업 메일 몫(MAIL_SITE_DAY)과는 다른 몫이다', async () => {
    const { raw, env } = setup();
    job(raw);
    await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    await sendAlerts(env, NOW);
    expect(raw.prepare('SELECT scope, n FROM usage_counters').all().map((r) => ({ ...r }))).toEqual([{ scope: 'alert_mail_site', n: 1 }]);
  });
});

describe.skipIf(!hasDb)('보낸 뒤에 기록 · 실패 · 자동 멈춤', () => {
  it('못 보내면 차례·확인 기준·토큰을 남기지 않고 실패 수 + 1, 5번 연속이면 멈춤 (failures)', async () => {
    const { raw, env, sent, mail } = setup();
    job(raw);
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    const before = row(raw, a);
    mail.fail = true;
    for (let i = 1; i <= ALERT_MAX_FAILURES; i++) {
      const r = await sendAlerts(env, NOW + i * 60);
      expect(r.done.failed).toBe(1);
      const x = row(raw, a);
      expect(x.fail_count).toBe(i);
      expect(x.next_due_at).toBe(before.next_due_at);
      expect(x.checked_until).toBe(before.checked_until);
      expect(x.status).toBe(i < ALERT_MAX_FAILURES ? 'active' : 'paused');
    }
    expect(row(raw, a).paused_reason).toBe('failures');
    expect(n(raw, 'SELECT COUNT(*) AS n FROM alert_unsub_tokens')).toBe(0);
    expect(sent).toEqual([]);
    expect(n(raw, "SELECT COUNT(*) AS n FROM email_log WHERE template = 'job_alert' AND result = 'error_500'")).toBe(ALERT_MAX_FAILURES);
    // 멈춘 뒤에는 시도하지 않는다
    mail.fail = false;
    expect((await sendAlerts(env, NOW + DAY)).done.due).toBe(0);
  });

  it('한 번 실패한 뒤 보내면 실패 수 0', async () => {
    const { raw, env, mail } = setup();
    job(raw);
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    mail.fail = true;
    await sendAlerts(env, NOW);
    mail.fail = false;
    await sendAlerts(env, NOW + 60);
    expect(row(raw, a)).toMatchObject({ fail_count: 0, last_sent_at: NOW + 60, status: 'active' });
  });

  it('보낸 메일의 해지 토큰은 해시만 저장된다 (원문은 DB 에 없음)', async () => {
    const { raw, env, sent } = setup();
    job(raw);
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    await sendAlerts(env, NOW);
    const token = /\/alerts\/u\/([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
    const tokens = raw.prepare('SELECT token_hash, alert_id FROM alert_unsub_tokens').all().map((r) => ({ ...r }));
    expect(tokens).toEqual([{ token_hash: await sha256Hex(token), alert_id: a }]);
    const dump = JSON.stringify(raw.prepare('SELECT * FROM alerts').all()) + JSON.stringify(raw.prepare('SELECT * FROM alert_unsub_tokens').all());
    expect(dump).not.toContain(token);
  });
});

describe.skipIf(!hasDb)('보내지 않는 때 · 숨긴 필터', () => {
  it('한국 시간 21:00~08:00 에는 보내지 않는다 (차례 그대로)', async () => {
    const { raw, env, sent } = setup();
    job(raw, { published: NOW - DAY });
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    for (const at of [kst(2027, 1, 18, 21), kst(2027, 1, 19, 3), kst(2027, 1, 19, 7, 59, 59)]) {
      raw.prepare('UPDATE alerts SET next_due_at = ? WHERE id = ?').run(at - 60, a);
      const r = await sendAlerts(env, at);
      expect(r.done.skipped_night).toBe(1);
    }
    expect(sent).toEqual([]);
    expect((await sendAlerts(env, kst(2027, 1, 19, 8))).done.sent).toBe(1);
  });

  it('점검 모드(MAINTENANCE=on)에는 보내지 않는다 (해지 화면이 503 이므로)', async () => {
    const { raw, env, sent } = setup({ MAINTENANCE: 'on' });
    job(raw);
    await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    expect((await sendAlerts(env, NOW)).done.skipped_maintenance).toBe(1);
    expect(sent).toEqual([]);
  });

  it('관리자가 숨긴 필터는 /jobs 처럼 무시하고, 적용되는 조건이 없으면 메일 없이 차례만 넘긴다(확인 기준은 그대로)', async () => {
    const { raw, env, sent } = setup();
    raw.exec(`INSERT INTO site_settings (key, value, updated_at) VALUES ('public_job_filters', '["chinese_level"]', 0)`);
    job(raw, { chinese: 'business', location: 'busan', title: '부산 비즈니스' });
    job(raw, { chinese: 'native', location: 'seoul', title: '서울 원어민' });
    const s1 = seeker(raw), s2 = seeker(raw);
    await alert(raw, env, s1.id, { chinese_level: 'business', location: 'seoul' });
    const onlyLoc = await alert(raw, env, s2.id, { location: 'seoul' });
    const before = row(raw, onlyLoc);
    const r = await sendAlerts(env, NOW);
    expect(r.done).toMatchObject({ sent: 1, no_filter: 1 });
    expect(sent[0]!.to).toBe(s1.email);
    expect(sent[0]!.text).toContain('부산 비즈니스'); // 근무지 조건은 지금 적용되지 않는다
    expect(sent[0]!.text).not.toContain('서울 원어민');
    expect(sent[0]!.text).not.toContain('근무지: 서울'); // 요약에도 실제로 쓴 조건만
    expect(row(raw, onlyLoc)).toMatchObject({ next_due_at: kst(2027, 1, 19, 9), checked_until: before.checked_until });
  });

  it('사용 종료된 근무지 조건은 넓어지지 않는다 (그 근무지의 공고만)', async () => {
    const { raw, env, sent } = setup();
    job(raw, { location: 'incheon', title: '인천 공고' });
    job(raw, { location: 'seoul', title: '서울 공고' });
    await alert(raw, env, seeker(raw).id, { location: 'incheon' });
    await sendAlerts(env, NOW);
    expect(sent[0]!.text).toContain('인천 공고');
    expect(sent[0]!.text).not.toContain('서울 공고');
  });
});

describe.skipIf(!hasDb)('정리·탈퇴', () => {
  it('탈퇴 계정의 알림, 12개월 안 쓴(멈춘) 알림, 180일 지난 토큰을 지운다 — 토큰은 알림과 함께(CASCADE)', async () => {
    const { raw, env } = setup();
    const del = seeker(raw, { status: 'deleted' });
    const delA = await alert(raw, env, del.id, { location: 'seoul' });
    const s = seeker(raw);
    const old = await alert(raw, env, s.id, { location: 'seoul' }, { created: NOW - 400 * DAY });
    const oldPaused = await alert(raw, env, s.id, { location: 'busan' }, { created: NOW - 400 * DAY });
    raw.prepare("UPDATE alerts SET status = 'paused', last_sent_at = ? WHERE id = ?").run(NOW - 10 * DAY, oldPaused);
    const recentSent = await alert(raw, env, s.id, { chinese_level: 'business' }, { created: NOW - 400 * DAY });
    raw.prepare('UPDATE alerts SET last_sent_at = ? WHERE id = ?').run(NOW - 30 * DAY, recentSent);
    const fresh = await alert(raw, env, s.id, { chinese_level: 'native' });
    const tok = (alertId: string, at: number, h: string) => raw.prepare('INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) VALUES (?,?,?)').run(h, alertId, at);
    tok(delA, NOW, 'h-del'); tok(old, NOW, 'h-old'); tok(fresh, NOW - 200 * DAY, 'h-expired'); tok(fresh, NOW - DAY, 'h-fresh');
    raw.prepare('UPDATE alerts SET status = \'paused\' WHERE id = ?').run(delA); // 차례와 관계없이 지운다
    const r = await sendAlerts(env, kst(2027, 1, 18, 23)); // 밤이어도 정리는 한다
    expect(r.done).toMatchObject({ swept_deleted_users: 1, swept_unused: 2, swept_tokens: 1, skipped_night: 1 });
    const left = raw.prepare('SELECT id FROM alerts ORDER BY id').all().map((x) => (x as { id: string }).id);
    expect(left.sort()).toEqual([recentSent, fresh].sort());
    expect(raw.prepare('SELECT token_hash FROM alert_unsub_tokens').all().map((x) => (x as { token_hash: string }).token_hash)).toEqual(['h-fresh']);
  });

  it('회원 탈퇴(eraseUser)가 알림과 해지 토큰을 지운다 — 외래키(켬)에 막히지 않는다', async () => {
    const { raw, env } = setup();
    const s = seeker(raw);
    job(raw);
    const a = await alert(raw, env, s.id, { location: 'seoul' });
    await sendAlerts(env, NOW);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM alert_unsub_tokens WHERE alert_id = ?', a)).toBe(1);
    expect(await eraseUser(env.DB, { id: s.id, email: s.email, marker: 'deleted-x@deleted.invalid', ts: NOW + 10 })).toBe(true);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM alerts')).toBe(0);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM alert_unsub_tokens')).toBe(0);
  });
});

describe.skipIf(!hasDb)('하위 요청 수 (무료 플랜: 실행당 50개)', () => {
  for (const [hour, host] of [[0, 'report'], [4, 'dropOldRows'], [6, 'purgeVerificationDocs'], [10, 'dropOldRows']] as const) {
    it(`${String(hour).padStart(2, '0')} UTC (${host} + sendAlerts): 후보가 상한보다 많아도 D1 호출 + fetch + R2 ≤ 45`, async () => {
      const { raw, env, cnt, mail, r2, sent } = setup({ OPS_EMAIL: 'fake.ops@example.test' });
      for (let i = 0; i < 3; i++) job(raw);
      for (let i = 0; i < 15; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
      for (let i = 0; i < 3; i++) await alert(raw, env, seeker(raw).id, { location: 'busan' }); // 새 공고 없음
      for (let i = 0; i < 8; i++) {
        raw.prepare("INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_at, created_at) VALUES (?, 'company', 'c1', 'biz_cert', ?, 'approved', 0, 0)")
          .run(uid(), `vdocs/company/c1/${i}.pdf`);
      }
      const at = Math.floor(NOW / DAY) * DAY + hour * 3600 + (NOW % 3600);
      cnt.c.calls = 0; cnt.c.statements = 0; mail.fetches = 0; r2.ops = 0;
      const out = await runMaintenance(env, at);
      expect(out.step).toBe(host);
      expect(out.also?.[0]).toMatchObject({ step: 'sendAlerts', ok: true });
      const alertMails = sent.filter((m) => m.subject.includes('새 공고')).length;
      expect(alertMails).toBe(ALERT_RUN_DEFAULT);
      const total = cnt.c.calls + mail.fetches + r2.ops;
      expect(total, `calls=${cnt.c.calls} fetch=${mail.fetches} r2=${r2.ops}`).toBeLessThanOrEqual(45);
    });
  }
  it('sendAlerts 단계만: 8 + 3 × 보낸 수 이하', async () => {
    const { raw, env, cnt, mail } = setup();
    job(raw);
    for (let i = 0; i < 15; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    cnt.c.calls = 0; mail.fetches = 0;
    const r = await sendAlerts(env, NOW);
    expect(r.done.sent).toBe(ALERT_RUN_DEFAULT);
    expect(cnt.c.calls + mail.fetches).toBeLessThanOrEqual(8 + 3 * ALERT_RUN_DEFAULT);
  });
});

// ───────── T-17: 관리자 설정의 알림 켜기/끄기 · 한도 (site_settings 'limits')
const setLimits = (raw: Raw, json: string) =>
  raw.prepare(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('limits',?,NULL,0)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(json);
const alertState = (raw: Raw) => raw.prepare('SELECT id, status, paused_reason, next_due_at, checked_until, fail_count, last_sent_at, updated_at FROM alerts ORDER BY id').all().map((r) => ({ ...r }));

describe.skipIf(!hasDb)('T-17 알림 발송 멈춤 (관리자가 끔 · 알림 메일 한도 0 · 처리 수 0)', () => {
  for (const [name, json, vars] of [
    ['관리자가 끔', '{"values":{},"alerts_enabled":false}', {}],
    ['관리자 설정 ALERT_MAIL_SITE_DAY = 0', '{"values":{"ALERT_MAIL_SITE_DAY":0}}', {}],
    ['관리자 설정 ALERT_SEND_PER_RUN = 0', '{"values":{"ALERT_SEND_PER_RUN":0}}', {}],
    ['설정 파일 ALERT_MAIL_SITE_DAY = 0', null, { ALERT_MAIL_SITE_DAY: '0' }],
  ] as const) {
    it(`${name}: 메일 없음, 알림 상태·차례·확인 기준·실패 수 그대로, 몫·토큰·email_log 없음`, async () => {
      const { raw, env, sent, mail } = setup(vars);
      if (json) setLimits(raw, json);
      job(raw);
      for (let i = 0; i < 3; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
      mail.fail = true; // 보냈다면 실패 수가 늘었을 것
      const before = alertState(raw);
      for (const at of [NOW, NOW + 4 * 3600, NOW + DAY]) {
        const r = await sendAlerts(env, at);
        expect(r.done).toMatchObject({ due: 0, sent: 0, failed: 0, auto_paused: 0, skipped_paused: 1 });
      }
      expect(sent).toHaveLength(0);
      expect(mail.fetches).toBe(0);
      expect(alertState(raw)).toEqual(before);
      expect(n(raw, 'SELECT COUNT(*) AS n FROM usage_counters')).toBe(0);
      expect(n(raw, 'SELECT COUNT(*) AS n FROM alert_unsub_tokens')).toBe(0);
      expect(n(raw, 'SELECT COUNT(*) AS n FROM email_log')).toBe(0);
    });
  }

  it('멈춘 동안 게재된 공고는 다시 켠 뒤 다음 메일에 들어간다 (최신 10건 + 외 N건)', async () => {
    const { raw, env, sent } = setup();
    job(raw, { published: NOW - 3 * DAY, title: '멈추기 전 공고' }); // 알림을 만든 때(NOW - 2일)보다 앞 — 보내지 않는다
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    const checkedBefore = row(raw, a).checked_until;
    setLimits(raw, '{"values":{},"alerts_enabled":false}');
    // 끈 동안 12건 게재 (NOW - 1일 ~), 예약 작업이 몇 번 돈다
    for (let i = 0; i < 12; i++) job(raw, { published: NOW - DAY + i * 60, title: `멈춘 동안 ${String(i).padStart(2, '0')}` });
    await sendAlerts(env, NOW);
    await sendAlerts(env, NOW + 4 * 3600);
    expect(sent).toHaveLength(0);
    expect(row(raw, a).checked_until).toBe(checkedBefore);
    // 다시 켬 (관리자 값 true — 기본값으로 되돌리기와 같은 결과)
    setLimits(raw, '{"values":{},"alerts_enabled":true}');
    const r = await sendAlerts(env, NOW + DAY);
    expect(r.done).toMatchObject({ sent: 1, skipped_paused: 0 });
    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    expect(sent[0]!.subject).toContain('12건');
    expect(text).toContain('멈춘 동안 11'); // 최신
    expect(text).toContain('멈춘 동안 02');
    expect(text).not.toContain('멈춘 동안 01'); // 10건만 적고
    expect(text).toContain('외 2건');            // 나머지는 "외 N건"
    expect(text).not.toContain('멈추기 전 공고');
    expect(row(raw, a).checked_until).toBe(NOW + DAY - 1);
  });

  it('멈춘 동안에는 "12개월 쓰지 않은 알림" 을 지우지 않는다 (탈퇴 계정 알림·오래된 토큰 정리는 한다)', async () => {
    const { raw, env } = setup();
    const a = await alert(raw, env, seeker(raw).id, { location: 'seoul' }, { created: NOW - 400 * DAY });
    raw.prepare('UPDATE alerts SET updated_at = ? WHERE id = ?').run(NOW - 400 * DAY, a);
    setLimits(raw, '{"values":{},"alerts_enabled":false}');
    expect((await sendAlerts(env, NOW)).done.swept_unused).toBe(0);
    expect(n(raw, 'SELECT COUNT(*) AS n FROM alerts')).toBe(1);
    setLimits(raw, '{"values":{}}');
    expect((await sendAlerts(env, NOW)).done.swept_unused).toBe(1);
  });

  it('관리자 설정의 처리 수·하루 메일 한도가 변수보다 먼저 (다시 배포 없음)', async () => {
    const { raw, env, sent } = setup({ ALERT_SEND_PER_RUN: '8', ALERT_MAIL_SITE_DAY: '40' });
    job(raw);
    for (let i = 0; i < 6; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    setLimits(raw, '{"values":{"ALERT_SEND_PER_RUN":2}}');
    expect((await sendAlerts(env, NOW)).done.sent).toBe(2);
    setLimits(raw, '{"values":{"ALERT_SEND_PER_RUN":10,"ALERT_MAIL_SITE_DAY":3}}');
    expect((await sendAlerts(env, NOW + 4 * 3600)).done).toMatchObject({ sent: 1, quota_stopped: 1 });
    expect(sent).toHaveLength(3);
    // 범위 밖 값(DB)은 무시 → 변수
    setLimits(raw, '{"values":{"ALERT_SEND_PER_RUN":50,"ALERT_MAIL_SITE_DAY":500}}');
    expect((await sendAlerts(env, NOW + 6 * 3600)).done.sent).toBe(3);
  });

  it('설정 읽기는 보일 필터와 한 번에 (보내는 경로의 하위 요청 수는 8 + 3n 그대로), 멈춤이면 2', async () => {
    const { raw, env, cnt, mail } = setup();
    job(raw);
    for (let i = 0; i < 15; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
    cnt.c.calls = 0; mail.fetches = 0;
    const r = await sendAlerts(env, NOW);
    expect(cnt.c.calls + mail.fetches).toBe(7 + 3 * r.done.sent!); // T-17 이전과 같은 수 (이전: 정리·차례·필터‖항목 2·공고·몫 2 = 7, 지금: 필터+한도 1·정리·차례·항목·공고·몫 2 = 7)
    setLimits(raw, '{"values":{},"alerts_enabled":false}');
    cnt.c.calls = 0; mail.fetches = 0;
    await sendAlerts(env, NOW + DAY);
    expect(cnt.c.calls + mail.fetches).toBe(2);
  });
});

describe.skipIf(!hasDb)('T-17 하위 요청 수: 관리자 설정의 최대 처리 수(10)', () => {
  const totals: Record<number, number> = {};
  for (const [hour, host] of [[0, 'report'], [4, 'dropOldRows'], [6, 'purgeVerificationDocs'], [10, 'dropOldRows']] as const) {
    it(`${String(hour).padStart(2, '0')} UTC (${host} + sendAlerts, ALERT_SEND_PER_RUN = 10): 무료 플랜 50 이하`, async () => {
      const { raw, env, cnt, mail, r2, sent } = setup({ OPS_EMAIL: 'fake.ops@example.test' });
      setLimits(raw, '{"values":{"ALERT_SEND_PER_RUN":10}}');
      for (let i = 0; i < 3; i++) job(raw);
      for (let i = 0; i < 15; i++) await alert(raw, env, seeker(raw).id, { location: 'seoul' });
      for (let i = 0; i < 3; i++) await alert(raw, env, seeker(raw).id, { location: 'busan' });
      for (let i = 0; i < 8; i++) {
        raw.prepare("INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_at, created_at) VALUES (?, 'company', 'c1', 'biz_cert', ?, 'approved', 0, 0)")
          .run(uid(), `vdocs/company/c1/${i}.pdf`);
      }
      const at = Math.floor(NOW / DAY) * DAY + hour * 3600 + (NOW % 3600);
      cnt.c.calls = 0; mail.fetches = 0; r2.ops = 0;
      const out = await runMaintenance(env, at);
      expect(out.step).toBe(host);
      expect(sent.filter((m) => m.subject.includes('새 공고')).length).toBe(10);
      totals[hour] = cnt.c.calls + mail.fetches + r2.ops;
      expect(totals[hour], `calls=${cnt.c.calls} fetch=${mail.fetches} r2=${r2.ops}`).toBeLessThanOrEqual(50);
    });
  }
});
