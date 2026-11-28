// 시연 계정 (lib/demo.ts · lib/demo-data.ts · lib/demo-seed.buildDemoSeed) — 순수 부분.
// 확인하는 것: 운영에서는 절대 켜지지 않는다 · 시연 계정에 관리자가 없다 · 시연 데이터가 폼 검사와 규칙 함수를 통과한다 ·
// 게재·검증·지원 상태가 규칙 함수의 결과와 같다 (시연 데이터라고 규칙을 건너뛰지 않는다).
import { describe, expect, it } from 'vitest';
import { b64url, decryptText, importEncKey } from '../src/lib/crypto';
import {
  DEMO_ACCOUNTS, DEMO_MAIL_DOMAIN, DEMO_RESET_AFTER, DEMO_SEED_VERSION, demoEnabled, demoId, demoSeedDue, findDemoAccount, isDemoAddress, isDemoId,
  isDemoUserId, parseDemoStamp,
} from '../src/lib/demo';
import { DEMO_APPLICATIONS, DEMO_COMPANIES, DEMO_JOBS, DEMO_RESUMES, DEMO_USERS } from '../src/lib/demo-data';
import { buildDemoSeed, demoDocPdf, type DemoSeedCtx } from '../src/lib/demo-seed';
import { validateCompany } from '../src/lib/company';
import { sniffType } from '../src/lib/files';
import { digitDiff, hasContactInText, inputFromJob, kstDate, validateJob, JOB_LIMITS } from '../src/lib/jobs';
import { isJobId } from '../src/lib/public-jobs';
import { validateResume } from '../src/lib/resume';
import { DEFAULT_RETENTION } from '../src/lib/retention';
import { findBannedPhrases, isValidBizNo, nextStatus, techLeakFlag, type AppStatus } from '../src/lib/rules';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';
import { SEED_OPTIONS } from './option-seed';

const NOW = 1_800_000_000;
const FLAGS = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
const OPERATOR = ['kimbbob.xyz', 'kimbbob.com', 'nexthub.me'];
const ENC = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const ctx = async (over: Partial<DemoSeedCtx> = {}): Promise<DemoSeedCtx> => ({
  now: NOW, encKey: await importEncKey(ENC), flags: FLAGS, appEnv: 'test', registrationNo: '', operatorDomains: OPERATOR, retention: DEFAULT_RETENTION, ...over,
});

describe('시연 로그인 켜짐 여부', () => {
  it('test·dev 에서 DEMO_LOGIN = "on" 일 때만 켜진다', () => {
    expect(demoEnabled({ APP_ENV: 'test', DEMO_LOGIN: 'on' })).toBe(true);
    expect(demoEnabled({ APP_ENV: 'dev', DEMO_LOGIN: 'on' })).toBe(true);
    for (const v of [undefined, '', 'off', 'ON', 'true', '1', true, 1]) expect(demoEnabled({ APP_ENV: 'test', DEMO_LOGIN: v })).toBe(false);
  });
  it('운영(production)과 알 수 없는 환경에서는 설정과 상관없이 꺼져 있다', () => {
    for (const env of ['production', 'prod', 'Production', '', undefined, 'staging']) expect(demoEnabled({ APP_ENV: env, DEMO_LOGIN: 'on' })).toBe(false);
  });
});

describe('시연 계정 목록', () => {
  it('관리자가 없고, 모두 고정 id·시연 주소이며, 시연 데이터의 회원과 같다', () => {
    expect(DEMO_ACCOUNTS.length).toBeGreaterThan(0);
    for (const a of DEMO_ACCOUNTS) {
      expect(['seeker', 'company']).toContain(a.role);
      expect(isDemoUserId(a.userId)).toBe(true);
      expect(isDemoAddress(a.email)).toBe(true);
      const u = DEMO_USERS.find((x) => x.id === a.userId);
      expect(u, a.key).toBeDefined();
      expect({ email: u!.email, role: u!.role, locale: u!.locale }).toEqual({ email: a.email, role: a.role, locale: a.locale });
      for (const k of [`demo.acct.${a.key}`, `demo.acct.${a.key}.d`]) { expect(k in ko, k).toBe(true); expect(k in zh, k).toBe(true); }
    }
    expect(new Set(DEMO_ACCOUNTS.map((a) => a.key)).size).toBe(DEMO_ACCOUNTS.length);
    expect((DEMO_USERS as ReadonlyArray<{ role: string }>).some((u) => u.role === 'admin')).toBe(false);
  });
  it('목록 밖의 이름으로는 계정을 찾지 못한다', () => {
    for (const k of ['', 'admin', 'seeker ', 'SEEKER', '__proto__', 'constructor', demoId(1, 1), 'seeker.kim@demo.example']) expect(findDemoAccount(k)).toBeNull();
    expect(findDemoAccount('seeker')?.userId).toBe(demoId(1, 1));
  });
  it('id 모양: 공고 주소에 쓸 수 있는 형식이고, 시연 id 가 아닌 것과 구분된다', () => {
    expect(isJobId(demoId(3, 41))).toBe(true);
    expect(isDemoId(demoId(5, 9))).toBe(true);
    expect(isDemoUserId(demoId(2, 1))).toBe(false);
    for (const id of ['', 'de300001', crypto.randomUUID(), `${demoId(1, 1)}x`, 'de300009-0000-4000-8000-000000000001']) expect(isDemoId(id)).toBe(false);
  });
  it('시연 주소 판별', () => {
    expect(isDemoAddress(`a@${DEMO_MAIL_DOMAIN}`)).toBe(true);
    expect(isDemoAddress(` HR@Lanhai.${DEMO_MAIL_DOMAIN.toUpperCase()} `)).toBe(true);
    for (const e of ['a@example.com', 'a@demo.example.com', 'a@notdemo.example', 'demo.example@gmail.com', '']) expect(isDemoAddress(e)).toBe(false);
  });
});

describe('되돌리기 시점', () => {
  it('넣은 적이 없거나, 판이 다르거나, 하루가 지났으면 다시 넣는다', () => {
    expect(demoSeedDue(null, NOW)).toBe(true);
    expect(demoSeedDue({ v: DEMO_SEED_VERSION, at: NOW - 10 }, NOW)).toBe(false);
    expect(demoSeedDue({ v: DEMO_SEED_VERSION, at: NOW - DEMO_RESET_AFTER }, NOW)).toBe(true);
    expect(demoSeedDue({ v: DEMO_SEED_VERSION + 1, at: NOW }, NOW)).toBe(true);
    expect(demoSeedDue({ v: DEMO_SEED_VERSION, at: NOW + 100 }, NOW)).toBe(true);
  });
  it('표시 값 해석', () => {
    expect(parseDemoStamp(JSON.stringify({ v: 1, at: 5 }))).toEqual({ v: 1, at: 5 });
    for (const raw of [null, '', 'x', '{}', '{"v":"1","at":5}', '[]', 'null']) expect(parseDemoStamp(raw)).toBeNull();
  });
});

describe('시연 데이터 원본', () => {
  const codes = (kind: string) => SEED_OPTIONS.filter((o) => o[0] === kind).map((o) => o[1]);
  const options = { role_category: codes('role_category'), industry: codes('industry'), location: codes('location') };

  it('id 가 겹치지 않고 서로 가리키는 것이 모두 있다', () => {
    const all = [...DEMO_USERS, ...DEMO_COMPANIES, ...DEMO_JOBS, ...DEMO_RESUMES, ...DEMO_APPLICATIONS].map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(isDemoId(id), id).toBe(true);
    expect(new Set(DEMO_USERS.map((u) => u.email)).size).toBe(DEMO_USERS.length);
    const users = new Set(DEMO_USERS.map((u) => u.id)), companies = new Set(DEMO_COMPANIES.map((c) => c.id));
    for (const c of DEMO_COMPANIES) {
      expect(c.members.filter((m) => m.member_role === 'owner').length, c.name_ko).toBe(1);
      for (const m of c.members) expect(DEMO_USERS.find((u) => u.id === m.userId)?.role, c.name_ko).toBe('company');
    }
    // 담당자 한 명은 기업 하나에만 소속된다 (1차 — routes/biz-ctx.ts)
    const memberIds = DEMO_COMPANIES.flatMap((c) => c.members.map((m) => m.userId));
    expect(new Set(memberIds).size).toBe(memberIds.length);
    for (const j of DEMO_JOBS) {
      expect(companies.has(j.companyId)).toBe(true);
      expect(DEMO_COMPANIES.find((c) => c.id === j.companyId)!.members.some((m) => m.userId === j.createdBy), j.title_zh).toBe(true);
    }
    for (const r of DEMO_RESUMES) expect(DEMO_USERS.find((u) => u.id === r.userId)?.role).toBe('seeker');
    for (const u of DEMO_USERS.filter((x) => x.role === 'seeker')) expect(DEMO_RESUMES.filter((r) => r.userId === u.id && r.isDefault === 1).length, u.email).toBe(1);
    for (const a of DEMO_APPLICATIONS) {
      expect(users.has(a.seekerId)).toBe(true);
      expect(DEMO_JOBS.some((j) => j.id === a.jobId)).toBe(true);
      expect(DEMO_RESUMES.find((r) => r.id === a.resumeId)?.userId).toBe(a.seekerId);
    }
    const pairs = DEMO_APPLICATIONS.map((a) => `${a.jobId}|${a.seekerId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('기업: 등록 폼 검사를 통과하고, 지어낸 것임이 이름과 소개에 적혀 있다', () => {
    for (const c of DEMO_COMPANIES) {
      const r = validateCompany({
        name_ko: c.name_ko, name_zh: c.name_zh, entity_type: c.entity_type, biz_no: c.biz_no ?? '', hq_name: c.hq_name, entry_stage: c.entry_stage,
        industry: c.industry, website: '', profile_ko: c.profile_ko,
      });
      expect(r.ok, c.name_ko).toBe(true);
      expect(c.name_ko).toContain('(예시)');
      expect(c.profile_ko).toContain('시연용 가상 기업');
      // 사업자번호 자리: 형식 검사만 통과하는 가짜 번호 (실제 세무서 코드가 아닌 000 으로 시작)
      if (c.biz_no) { expect(isValidBizNo(c.biz_no)).toBe(true); expect(c.biz_no.startsWith('000')).toBe(true); }
      else expect(c.entity_type).toBe('cn_hq');
    }
    const bizNos = DEMO_COMPANIES.map((c) => c.biz_no).filter(Boolean);
    expect(new Set(bizNos).size).toBe(bizNos.length);
  });

  it('공고: 작성 폼 검사를 통과하고, 금지 표현·본문 속 연락처가 없고, 연락처는 시연 주소다', () => {
    for (const j of DEMO_JOBS) {
      const input = inputFromJob({
        title_zh: j.title_zh, source_zh: j.source_zh, job_family: 'office', role_category: j.role_category, industry: j.industry, location: j.location,
        salary_min: j.salary_min, salary_max: j.salary_max, salary_basis: j.salary_basis, work_hours: j.work_hours, report_line: j.report_line,
        chinese_level: j.chinese_level, contact_email: j.contact_email, closes_at: null,
      });
      if (j.closesInDays !== null) input.closes_at = kstDate(NOW + j.closesInDays * 86400);
      const r = validateJob(input, { flags: FLAGS, operatorDomains: OPERATOR, now: NOW, options });
      expect(r.ok ? [] : r.errors, j.title_zh).toEqual([]);
      expect(isDemoAddress(j.contact_email)).toBe(true);
      const text = [j.title_zh, j.source_zh, j.title_ko ?? '', j.body_ko ?? ''].join('\n');
      expect(findBannedPhrases(text), j.title_zh).toEqual([]);
      expect(hasContactInText(text), j.title_zh).toBe(false);
      expect((j.title_ko === null) === (j.body_ko === null)).toBe(true);
      if (j.title_ko && j.body_ko) {
        expect(j.title_ko.length).toBeLessThanOrEqual(JOB_LIMITS.title);
        expect(j.body_ko.length).toBeLessThanOrEqual(JOB_LIMITS.body);
        // 원문과 한국어의 숫자가 어긋나지 않는다 (화면의 숫자 대조 경고가 뜨지 않게)
        expect(digitDiff(`${j.title_zh}\n${j.source_zh}`, `${j.title_ko}\n${j.body_ko}`), j.title_zh).toEqual({ missing: [], extra: [] });
      }
    }
  });

  it('이력서: 작성 폼 검사를 통과하고, 전화번호가 없고, 연락처는 시연 주소다', () => {
    for (const r of DEMO_RESUMES) {
      const v = validateResume({
        title: r.title, lang: 'ko', name: r.body.name, chinese_level: r.body.chinese_level, years: String(r.body.years), headline: r.body.headline,
        contact_email: r.body.contact_email, phone: '', desired_role: r.body.desired_role ?? '', experience_text: r.body.experience_text ?? '',
      });
      expect(v.ok, r.title).toBe(true);
      expect(r.body.phone).toBeNull();
      expect(isDemoAddress(r.body.contact_email)).toBe(true);
      expect(r.body.name).toContain('(시연)');
    }
  });

  it('화면 문구가 한국어·중국어 모두 있다', () => {
    for (const k of ['demo.title', 'demo.lead', 'demo.note', 'err.demo_unavailable', 'acct.block.demo']) { expect(k in ko, k).toBe(true); expect(k in zh, k).toBe(true); }
  });
});

describe('buildDemoSeed: 상태는 규칙 함수가 정한다', () => {
  it('확인을 마친 기업으로 넣는 것은 서류 행이 있고 사업자번호가 맞는 기업뿐이다', async () => {
    const s = await buildDemoSeed(await ctx());
    for (const c of s.companies) {
      const want = DEMO_COMPANIES.find((x) => x.id === c.id)!.wantVerified;
      expect(c.verify_status, c.name_ko).toBe(want ? 'verified' : 'pending');
      expect(s.docs.some((d) => d.company_id === c.id)).toBe(want);
      expect(c.verified_at === null).toBe(!want);
    }
    expect(s.companies.some((c) => c.verify_status === 'pending')).toBe(true);
    for (const d of s.docs) expect(d.r2_key.startsWith(`vdocs/company/${d.company_id}/`)).toBe(true);
  });

  it('게재되는 공고는 모두 게재 조건을 만족하고, 기술유출 필터에 걸린 공고와 확인 전 기업의 공고는 초안으로 남는다', async () => {
    const s = await buildDemoSeed(await ctx());
    const verified = new Set(s.companies.filter((c) => c.verify_status === 'verified').map((c) => c.id));
    const published = s.jobs.filter((j) => j.status === 'published');
    expect(published.length).toBeGreaterThanOrEqual(12);
    for (const j of published) {
      expect(verified.has(j.company_id), j.title_ko ?? '').toBe(true);
      expect(j.localize_status).toBe('approved');
      expect(j.review_flag).toBeNull();
      expect(j.title_ko && j.body_ko && j.contact_email).toBeTruthy();
      expect(j.published_at).not.toBeNull();
      if (j.closes_at !== null) expect(j.closes_at).toBeGreaterThan(NOW);
      if (j.salary_min !== null) expect(j.salary_basis).not.toBeNull();
    }
    const flagged = s.jobs.filter((j) => j.review_flag !== null);
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.status).toBe('draft');
    expect(techLeakFlag(`${flagged[0]!.title_ko}\n${flagged[0]!.body_ko}`)).toBe('core_tech_rnd');
    for (const j of s.jobs.filter((x) => !verified.has(x.company_id))) expect(j.status).toBe('draft');
    expect(s.jobs.filter((j) => j.status === 'closed').length).toBe(1);
    for (const j of s.jobs.filter((x) => x.status !== 'published')) expect(j.closes_at).toBeNull();
    for (const j of s.jobs.filter((x) => x.status === 'draft')) expect(j.published_at).toBeNull();
  });

  it('기업이 확인되지 않으면(예: 서류 규칙이 막으면) 그 기업의 공고는 하나도 게재되지 않는다', async () => {
    // 운영자 도메인 목록에 시연 도메인이 들어가면 연락처 규칙이 모든 공고를 막는다 — 시연 데이터도 게재 규칙을 그대로 따른다는 확인
    const s = await buildDemoSeed(await ctx({ operatorDomains: [DEMO_MAIL_DOMAIN] }));
    expect(s.jobs.filter((j) => j.status === 'published')).toEqual([]);
    expect(s.jobs.filter((j) => j.status === 'closed')).toEqual([]);
    // 게재된 공고가 없으면 지원도 들어가지 않는다 (지원 조건: 공개된 공고)
    expect(s.applications).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('지원: 상태는 이벤트를 nextStatus 로 적용한 결과이고, 국외 이전 동의는 필요한 기업에만 남는다', async () => {
    const s = await buildDemoSeed(await ctx());
    expect(s.applications.length).toBe(DEMO_APPLICATIONS.length);
    for (const a of s.applications) {
      const evs = s.events.filter((e) => e.application_id === a.id).sort((x, y) => x.at - y.at);
      let st: AppStatus = 'submitted';
      for (const e of evs) st = nextStatus(st, e.event as never);
      expect(a.status, a.id).toBe(st);
      expect(a.status_changed_at).toBeGreaterThanOrEqual(a.created_at);
      expect(a.keep_days).toBe(DEFAULT_RETENTION.application_keep_days);
      for (const e of evs) {
        expect(e.at).toBeGreaterThanOrEqual(a.created_at);
        // 이벤트를 낸 사람은 그 공고 기업의 담당자다
        const job = s.jobs.find((j) => j.id === a.job_id)!;
        expect(s.members.some((m) => m.company_id === job.company_id && m.user_id === e.actor_id)).toBe(true);
      }
      // 열람 이벤트마다 열람 기록이 있다 (규칙 4)
      expect(s.accessLogs.filter((l) => l.target_id === a.id).length).toBe(evs.filter((e) => e.event === 'viewed').length);
      const job = s.jobs.find((j) => j.id === a.job_id)!;
      const hq = s.members.filter((m) => m.company_id === job.company_id && m.is_hq === 1).length;
      const local = s.members.filter((m) => m.company_id === job.company_id && m.is_hq === 0).length;
      if (hq === 0) expect(a.cross_border_consent_at, a.id).toBeNull();
      if (hq > 0 && local === 0) expect(a.cross_border_consent_at, a.id).not.toBeNull();
      expect(s.crossBorderConsents.filter((c) => c.ref_id === a.id).length).toBe(a.cross_border_consent_at === null ? 0 : 1);
    }
    // 시연용으로 여러 단계가 고루 있다
    expect(new Set(s.applications.map((a) => a.status))).toEqual(new Set(['submitted', 'viewed', 'interview', 'rejected']));
    // 본사 소속 담당자가 열 수 없는 지원(동의 없음)과 열 수 있는 지원이 같은 기업에 함께 있다
    const lanhai = DEMO_COMPANIES[0]!.id;
    const ofLanhai = s.applications.filter((a) => s.jobs.find((j) => j.id === a.job_id)!.company_id === lanhai);
    expect(ofLanhai.some((a) => a.cross_border_consent_at === null)).toBe(true);
    expect(ofLanhai.some((a) => a.cross_border_consent_at !== null)).toBe(true);
    for (const c of s.crossBorderConsents) expect(c.version).toBe(`2026-11-1/k${DEFAULT_RETENTION.application_keep_days}`);
  });

  it('이력서·지원서는 암호문만 들어가고, 같은 키로 풀면 원본과 같다', async () => {
    const c = await ctx();
    const s = await buildDemoSeed(c);
    for (const r of s.resumes) {
      expect(r.body.startsWith('v1.')).toBe(true);
      expect(r.body).not.toContain('시연');
      const src = DEMO_RESUMES.find((x) => x.id === r.id)!;
      expect(JSON.parse(await decryptText(c.encKey, r.body))).toEqual({ v: 1, ...src.body, file: null });
    }
    for (const a of s.applications) {
      expect(a.resume_snapshot.startsWith('v1.')).toBe(true);
      const body = JSON.parse(await decryptText(c.encKey, a.resume_snapshot)) as { name: string; file: unknown };
      expect(body.name).toBe(DEMO_RESUMES.find((x) => x.id === a.resume_id)!.body.name);
      expect(body.file).toBeNull();
    }
  });

  it('필수 동의는 지금 판으로 남기고, 넣은 시각 표시가 지금 판·지금 시각이다', async () => {
    const s = await buildDemoSeed(await ctx());
    expect(s.requiredConsents.map((x) => x.type).sort()).toEqual(['privacy', 'terms']);
    expect(parseDemoStamp(s.stampValue)).toEqual({ v: DEMO_SEED_VERSION, at: NOW });
    expect(s.users.map((u) => u.role).every((r) => r === 'seeker' || r === 'company')).toBe(true);
  });

  it('예시 서류는 PDF 로 판별되고 실제 서류가 아님을 적어 둔다', () => {
    const pdf = demoDocPdf();
    expect(sniffType(pdf.slice(0, 8))).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    const text = new TextDecoder().decode(pdf);
    expect(text).toContain('not a real certificate');
    // 교차 참조표의 위치가 실제 객체 위치와 같다
    const xref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offs = [...text.slice(xref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
