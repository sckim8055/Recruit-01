// T-11 핵심: 약관·개인정보 동의 판단, 동의 기록, 회원 탈퇴(무엇이 지워지고 무엇이 남는지), 문서 본문의 일관성.
import { describe, expect, it } from 'vitest';
import { confirmMatches, deleteAccount, deletedMarker, deletionBlocks } from '../src/lib/account';
import { CROSS_BORDER_VERSION, WITHDRAWABLE } from '../src/lib/application';
import {
  consentExempt, missingConsents as missingFor, needsConsentCheck, readConsentForm, requiredConsents, safeNext, PRIVACY_VERSION, TERMS_VERSION,
  type ConsentRow,
} from '../src/lib/consent';
import { DEFAULT_RETENTION } from '../src/lib/retention';
import type { Db } from '../src/db/types';

// T-12c: 필수 동의의 판은 보관 기간 설정에 따라 정해진다. 이 파일의 판단 테스트는 설정이 없을 때(기본값)의 판으로 본다.
const missingConsents = (rows: ConsentRow[]) => missingFor(rows, requiredConsents(DEFAULT_RETENTION));
import { t } from '../src/lib/i18n';
import { PRIVACY } from '../src/legal/privacy';
import { renderLegal, tRetention } from '../src/legal/render';
import { TERMS } from '../src/legal/terms';
import { countOwnedCompaniesWithOthers, eraseUser } from '../src/db/account';
import { insertConsents, listRequiredConsents } from '../src/db/consents';
import { findSessionUser } from '../src/db/sessions';
import type { Env, SessionUser } from '../src/env';
import { hasDb, migratedDb } from './pg-test-db';

describe('필수 동의', () => {
  const ok = [{ type: 'terms', version: TERMS_VERSION, withdrawn_at: null }, { type: 'privacy', version: PRIVACY_VERSION, withdrawn_at: null }];
  it('지금 판의 유효한 동의가 둘 다 있어야 통과', () => {
    expect(missingConsents(ok)).toEqual([]);
    expect(missingConsents([])).toEqual(['terms', 'privacy']);
    expect(missingConsents([ok[0]!])).toEqual(['privacy']);
    expect(missingConsents([{ ...ok[0]!, version: 'old' }, ok[1]!])).toEqual(['terms']);          // 옛 판
    expect(missingConsents([ok[0]!, { ...ok[1]!, withdrawn_at: 5 }])).toEqual(['privacy']);       // 철회함
    expect(missingConsents([...ok, { type: 'cross_border', version: 'x', withdrawn_at: null }])).toEqual([]);
  });
  it('동의 없이도 열 수 있는 주소: 문서·로그인·로그아웃·언어·탈퇴', () => {
    for (const p of ['/consent', '/terms', '/privacy', '/logout', '/login', '/login/totp', '/lang/zh', '/my/account', '/my/account/delete']) expect(consentExempt(p)).toBe(true);
    for (const p of ['/', '/my', '/my/resumes', '/my/accounts', '/biz', '/jobs/x/apply', '/termsx', '/consentx']) expect(consentExempt(p)).toBe(false);
  });
  it('로그인한 회원(관리자 제외)만 확인한다', () => {
    expect(needsConsentCheck(null, '/my')).toBe(false);
    expect(needsConsentCheck('admin', '/admin')).toBe(false);
    expect(needsConsentCheck('seeker', '/my/resumes')).toBe(true);
    expect(needsConsentCheck('company', '/biz')).toBe(true);
    expect(needsConsentCheck('seeker', '/my/account')).toBe(false);
    expect(needsConsentCheck('seeker', '/')).toBe(true);
  });
  it('동의 폼은 두 항목 모두 체크해야 한다', () => {
    expect(readConsentForm({ terms: '1', privacy: 'on' })).toEqual({ ok: true });
    expect(readConsentForm({ terms: '1' })).toEqual({ ok: false, missing: ['privacy'] });
    expect(readConsentForm({})).toEqual({ ok: false, missing: ['terms', 'privacy'] });
  });
  it('돌아갈 주소는 사이트 안의 경로만', () => {
    expect(safeNext('/biz/jobs')).toBe('/biz/jobs');
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil', undefined, '', '/consent', '/login']) expect(safeNext(bad)).toBe('/my');
  });
});

describe('탈퇴 판단', () => {
  it('관리자와, 다른 담당자가 있는 기업의 대표 담당자는 탈퇴할 수 없다', () => {
    expect(deletionBlocks({ role: 'seeker', ownedCompaniesWithOthers: 0 })).toEqual([]);
    expect(deletionBlocks({ role: 'company', ownedCompaniesWithOthers: 0 })).toEqual([]);
    expect(deletionBlocks({ role: 'company', ownedCompaniesWithOthers: 1 })).toEqual(['owner_with_members']);
    expect(deletionBlocks({ role: 'admin', ownedCompaniesWithOthers: 0 })).toEqual(['admin']);
  });
  it('확인 문구는 본인 이메일과 같아야 한다', () => {
    expect(confirmMatches(' Hong@Example.test ', 'hong@example.test')).toBe(true);
    expect(confirmMatches('hong@example.tes', 'hong@example.test')).toBe(false);
    expect(confirmMatches(undefined, 'hong@example.test')).toBe(false);
    expect(deletedMarker()).toMatch(/^deleted-[0-9a-f-]{36}@deleted\.invalid$/);
    expect(deletedMarker()).not.toBe(deletedMarker());
  });
});

describe.skipIf(!hasDb)('동의 기록', () => {
  it('같은 판의 동의는 한 줄만, 판이 바뀌면 새 줄', async () => {
    const { raw, d1 } = migratedDb();
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('s1','s1@example.test','seeker',0)");
    const items = [{ type: 'terms', version: TERMS_VERSION }, { type: 'privacy', version: PRIVACY_VERSION }];
    await insertConsents(d1, 's1', items, 100);
    await insertConsents(d1, 's1', items, 200);
    expect(await listRequiredConsents(d1, 's1')).toHaveLength(2);
    expect(missingConsents(await listRequiredConsents(d1, 's1'))).toEqual([]);
    await insertConsents(d1, 's1', [{ type: 'terms', version: 'next' }], 300);
    expect(await listRequiredConsents(d1, 's1')).toHaveLength(3);
    expect(await listRequiredConsents(d1, 'nobody')).toEqual([]);
  });
});

describe.skipIf(!hasDb)('회원 탈퇴', () => {
  const setup = () => {
    const { raw, d1 } = migratedDb();
    raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
      ('s1','s1@example.test','seeker','active',0), ('s2','s2@example.test','seeker','active',0),
      ('m1','m1@example.test','company','active',0), ('m2','m2@example.test','company','active',0), ('solo','solo@example.test','company','active',0)`);
    raw.exec(`INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0), ('c2','혼자기업','kr_entity','verified',0)`);
    raw.exec(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','m1','owner',0,0), ('c1','m2','member',0,0), ('c2','solo','owner',0,0)`);
    raw.exec(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, created_at, updated_at) VALUES
      ('j1','c1','m1','office','영업','본문','approved','published',0,0), ('j2','c2','solo','office','혼자공고','본문','approved','published',0,0), ('j3','c2','solo','office','초안','본문','approved','draft',0,0)`);
    raw.exec(`INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES ('r1','s1','기본',1,'v1.x.y','rfiles/r1',0,0), ('r9','s2','남의것',1,'v1.x.y',NULL,0,0)`);
    raw.exec(`INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, file_r2_key, cross_border_consent_at, status, status_changed_at, created_at) VALUES
      ('a1','j1','s1','v1.snap.1','rfiles/a1',5,'viewed',10,10), ('a2','j2','s1','v1.snap.2',NULL,NULL,'rejected',20,10), ('b1','j1','s2','v1.snap.3','rfiles/b1',NULL,'submitted',10,10)`);
    raw.exec(`INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES ('k1','s1','terms','${TERMS_VERSION}',NULL,1), ('k2','s1','cross_border','${CROSS_BORDER_VERSION}','a1',5), ('k3','s2','terms','${TERMS_VERSION}',NULL,1)`);
    raw.exec("INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES ('sess1','s1',0,9999999999,0), ('sess2','s2',0,9999999999,0)");
    raw.exec("INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES ('l1','m1','company','application','a1',NULL,11), ('l2','s1','seeker','resume','r1',NULL,12)");
    raw.exec("INSERT INTO company_invites (id, company_id, email, is_hq, invited_by, created_at) VALUES ('i1','c1','s1@example.test',0,'m1',0)");
    const one = (sql: string) => ({ ...raw.prepare(sql).get()! });
    const n = (sql: string) => Number(raw.prepare(sql).get()!.n);
    return { raw, d1, one, n };
  };
  const erase = (d1: Db, id: string, email: string) => eraseUser(d1, { id, email, marker: `deleted-${id}@deleted.invalid`, ts: 500 });

  it('탈퇴 문장의 "진행 중" 상태 목록은 취소할 수 있는 상태(WITHDRAWABLE)와 같다', async () => {
    const fsMod = 'node:fs';
    const src = ((await import(fsMod)) as { readFileSync(p: string, e: 'utf8'): string }).readFileSync('src/db/account.ts', 'utf8');
    const m = /const ACTIVE = "\(([^)]*)\)"/.exec(src);
    expect(m![1]!.split(',').map((x) => x.trim().replace(/'/g, '')).sort()).toEqual([...WITHDRAWABLE].sort());
  });
  it('구직자: 이력서·지원서 내용·세션이 지워지고, 진행 중이던 지원은 취소로 남는다', async () => {
    const { d1, one, n, raw } = setup();
    expect(await erase(d1, 's1', 's1@example.test')).toBe(true);
    expect(one("SELECT email, status FROM users WHERE id = 's1'")).toEqual({ email: 'deleted-s1@deleted.invalid', status: 'deleted' });
    expect(n("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's1'")).toBe(0);
    expect(one("SELECT status, status_changed_at, resume_snapshot, file_r2_key, purge_after FROM applications WHERE id = 'a1'"))
      .toEqual({ status: 'withdrawn', status_changed_at: 500, resume_snapshot: '', file_r2_key: null, purge_after: 500 });
    // 이미 끝난 지원은 상태는 그대로, 내용만 지워진다
    expect(one("SELECT status, status_changed_at, resume_snapshot FROM applications WHERE id = 'a2'")).toEqual({ status: 'rejected', status_changed_at: 20, resume_snapshot: '' });
    expect(raw.prepare("SELECT application_id, event, actor_id, at FROM application_events").all().map((r) => ({ ...r }))).toEqual([{ application_id: 'a1', event: 'withdrawn', actor_id: 's1', at: 500 }]);
    expect(n("SELECT COUNT(*) AS n FROM consents WHERE user_id = 's1' AND withdrawn_at = 500")).toBe(2);
    expect(n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 's1'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM company_invites WHERE email = 's1@example.test'")).toBe(0);
    expect(await findSessionUser(d1, 'sess1', 600)).toBeNull();
    // 열람 기록은 남는다
    expect(n('SELECT COUNT(*) AS n FROM access_log')).toBe(2);
  });
  it('다른 회원의 자료는 건드리지 않는다', async () => {
    const { d1, one, n } = setup();
    await erase(d1, 's1', 's1@example.test');
    expect(one("SELECT email, status FROM users WHERE id = 's2'")).toEqual({ email: 's2@example.test', status: 'active' });
    expect(n("SELECT COUNT(*) AS n FROM resumes WHERE user_id = 's2'")).toBe(1);
    expect(one("SELECT status, resume_snapshot, file_r2_key FROM applications WHERE id = 'b1'")).toEqual({ status: 'submitted', resume_snapshot: 'v1.snap.3', file_r2_key: 'rfiles/b1' });
    expect(n("SELECT COUNT(*) AS n FROM consents WHERE user_id = 's2' AND withdrawn_at IS NULL")).toBe(1);
    expect((await findSessionUser(d1, 'sess2', 600))?.id).toBe('s2');
  });
  it('두 번 지울 수 없고, 같은 이메일로 다시 가입할 수 있다', async () => {
    const { raw, d1, n } = setup();
    expect(await erase(d1, 's1', 's1@example.test')).toBe(true);
    expect(await erase(d1, 's1', 's1@example.test')).toBe(false);
    expect(n('SELECT COUNT(*) AS n FROM application_events')).toBe(1);
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('s1b','s1@example.test','seeker',600)");
    expect(n("SELECT COUNT(*) AS n FROM users WHERE email = 's1@example.test'")).toBe(1);
  });
  it('혼자 맡던 기업의 담당자: 게재 중 공고가 마감되고 소속이 지워진다 (초안·남의 기업 공고는 그대로)', async () => {
    const { d1, one, n } = setup();
    expect(await countOwnedCompaniesWithOthers(d1, 'solo')).toBe(0);
    expect(await erase(d1, 'solo', 'solo@example.test')).toBe(true);
    expect(one("SELECT status FROM jobs WHERE id = 'j2'")).toEqual({ status: 'closed' });
    expect(one("SELECT status FROM jobs WHERE id = 'j3'")).toEqual({ status: 'draft' });
    expect(one("SELECT status FROM jobs WHERE id = 'j1'")).toEqual({ status: 'published' });
    expect(n("SELECT COUNT(*) AS n FROM company_members WHERE user_id = 'solo'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM companies WHERE id = 'c2'")).toBe(1);
  });
  it('다른 담당자가 있는 기업의 대표는 막히고, 일반 담당자는 나갈 수 있다 (공고는 유지)', async () => {
    const { d1, one, n } = setup();
    expect(await countOwnedCompaniesWithOthers(d1, 'm1')).toBe(1);
    expect(await countOwnedCompaniesWithOthers(d1, 'm2')).toBe(0);
    expect(await erase(d1, 'm2', 'm2@example.test')).toBe(true);
    expect(one("SELECT status FROM jobs WHERE id = 'j1'")).toEqual({ status: 'published' });
    expect(n("SELECT COUNT(*) AS n FROM company_members WHERE company_id = 'c1'")).toBe(1);
    expect(await countOwnedCompaniesWithOthers(d1, 'm1')).toBe(0);
  });
  it('deleteAccount: 막히면 아무것도 지우지 않고, 지우면 그 회원의 파일을 모두 지운다', async () => {
    const { d1, one } = setup();
    const deleted: string[] = [];
    const env = { DB: d1, FILES: { delete: async (k: string) => { deleted.push(k); } } } as unknown as Env;
    const u = (id: string, role: SessionUser['role']): SessionUser => ({ id, email: `${id}@example.test`, role, locale: 'ko' });
    expect(await deleteAccount(env, u('m1', 'company'))).toEqual({ ok: false, blocks: ['owner_with_members'] });
    expect(await deleteAccount(env, u('adm', 'admin'))).toEqual({ ok: false, blocks: ['admin'] });
    expect(one("SELECT status FROM users WHERE id = 'm1'")).toEqual({ status: 'active' });
    expect(deleted).toEqual([]);
    expect(await deleteAccount(env, u('s1', 'seeker'))).toEqual({ ok: true, filesLeft: 0 });
    expect(deleted.sort()).toEqual(['rfiles/a1', 'rfiles/r1']);   // 남의 파일(rfiles/b1)은 없다
    expect(await deleteAccount(env, u('s1', 'seeker'))).toEqual({ ok: false, blocks: [], why: 'already' });
  });
  it('파일 지우기가 실패해도 탈퇴는 끝난다 (남은 수를 알려 준다)', async () => {
    const { d1, one } = setup();
    const env = { DB: d1, FILES: { delete: async () => { throw new Error('r2 down'); } } } as unknown as Env;
    const { vi } = await import('vitest');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deleteAccount(env, { id: 's1', email: 's1@example.test', role: 'seeker', locale: 'ko' })).toEqual({ ok: true, filesLeft: 2 });
    expect(one("SELECT status FROM users WHERE id = 's1'")).toEqual({ status: 'deleted' });
    expect(spy.mock.calls.flat().join(' ')).not.toContain('example.test');
    spy.mockRestore();
  });
});

describe('문서 본문', () => {
  it('한국어·중국어의 조항 수와 항목 수가 같다', () => {
    for (const doc of [TERMS, PRIVACY]) {
      expect(doc.zh.sections.length).toBe(doc.ko.sections.length);
      doc.ko.sections.forEach((s, i) => expect(doc.zh.sections[i]!.items.length, s.h).toBe(s.items.length));
      expect(doc.zh.intro.join('')).toContain('以韩文版为准');
    }
  });
  it('금지 표현이 없고, 알선하지 않는다는 점을 밝힌다', () => {
    const all = JSON.stringify([TERMS, PRIVACY]);
    for (const s of ['취업상담', '취업추천', '취업지원', '취업알선']) expect(all).not.toContain(s);
    expect(TERMS.ko.intro.join('')).toContain('직업정보제공사업');
    expect(JSON.stringify(TERMS.ko)).toContain('추천하지 않');
  });
  it('보관 기간·국외 이전 내용이 지원 화면의 동의 문구와 같다 (180일, 중국, 취소하면 철회)', () => {
    // T-12c: 기간은 자리표시자 → 설정이 없을 때(기본값)로 채운 글로 비교한다
    const p = JSON.stringify(renderLegal(PRIVACY, DEFAULT_RETENTION).ko);
    expect(p).toContain('180일');
    expect(p).toContain('Cloudflare');
    expect(p).toContain('Resend');
    for (const k of ['apply.consent.optional.text', 'apply.consent.required.text']) {
      expect(tRetention('ko', k, DEFAULT_RETENTION)).toContain('180일');
      expect(t('ko', k)).toContain('국외 이전');
      expect(t('ko', k)).toContain('철회');
      expect(tRetention('zh', k, DEFAULT_RETENTION)).toContain('180天');
      expect(t('zh', k)).toContain('跨境转移');
    }
  });
  it('운영자가 채워야 할 표시가 남아 있다 — 0 이 될 때까지 운영 환경에 올리지 않는다', () => {
    const marks = (JSON.stringify([TERMS.ko, PRIVACY.ko]).match(/【확인 필요/g) ?? []).length;
    expect(marks).toBeGreaterThan(0); // 운영자가 모두 채우면 이 테스트를 toBe(0) 으로 바꾸고 배포 점검 항목으로 쓴다
  });
});
