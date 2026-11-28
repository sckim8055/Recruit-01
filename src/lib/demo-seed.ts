// 시연 데이터 넣기·되돌리기와 시연 로그인 (테스트 서버·로컬 개발 전용). 배경과 안전장치는 lib/demo.ts 머리말.
//
// 판단은 모두 기존 규칙 함수로 한다 — 시연 데이터라고 규칙을 건너뛰지 않는다:
//   - 기업 검증 상태: rules.verifyBlocks 가 빈 배열일 때만 verified (서류 행이 있어야 하고 사업자번호 형식이 맞아야 한다)
//   - 공고 게재: rules.publishBlocks 가 빈 배열일 때만 published (CLAUDE.md 규칙 2). 기술유출 필터(techLeakFlag)에 걸리면 초안으로 남는다
//   - 지원: lib/application.applyBlocks 가 빈 배열일 때만 넣고, 상태는 이벤트를 rules.nextStatus 로 적용한 결과다 (규칙 3)
//   - 이력서·지원서는 lib/resume.sealResume 으로 암호화한 값만 넣는다 (규칙 5)
// 언제 넣는가: 시연 로그인 때, 넣은 적이 없거나 하루가 지났거나(lib/demo.demoSeedDue) 고른 계정을 쓸 수 없을 때. 예약 작업에는 붙이지 않는다.
import { flagsOf, now, type Env, type Flags, type SessionUser } from '../env';
import { applyBlocks, buildSnapshot, consentAt, consentNeed, crossBorderVersion } from './application';
import { createSession } from './auth';
import { requiredConsents } from './consent';
import { importEncKey } from './crypto';
import {
  DEMO_APPLICATIONS, DEMO_COMPANIES, DEMO_JOBS, DEMO_RESUMES, DEMO_USERS, type DemoCompany,
} from './demo-data';
import { DEMO_SEED_VERSION, DEMO_STAMP_KEY, demoEnabled, demoId, demoSeedDue, findDemoAccount, isDemoUserId, parseDemoStamp } from './demo';
import { flagText, kstDate, parseKstDate, publishInputOf } from './jobs';
import { resumeReadyToApply, sealResume, type ResumeBody } from './resume';
import { DAY, type RetentionSettings } from './retention';
import { loadRetention } from './retention-setting';
import { nextStatus, parseOperatorDomains, publishBlocks, techLeakFlag, verifyBlocks, type AppStatus } from './rules';
import {
  applyDemoSeed, findDemoUser, listExtraDemoDocKeys, type DemoApplicationRow, type DemoCompanyRow, type DemoJobRow, type DemoSeedRows,
} from '../db/demo';
import { getSetting } from '../db/settings';

const docTypeOf = (c: DemoCompany): 'biz_cert' | 'cn_license' => (c.entity_type === 'kr_entity' ? 'biz_cert' : 'cn_license');
const companyNo = (c: DemoCompany): number => Number(c.id.slice(-12));
/** 시연 기업의 예시 서류가 놓이는 R2 키 (실제 서류가 아니다 — demoDocPdf). */
export const demoDocKey = (c: DemoCompany): string => `vdocs/company/${c.id}/${demoId(6, companyNo(c))}.pdf`;

export interface DemoSeedCtx {
  now: number;
  encKey: CryptoKey;
  flags: Flags;
  appEnv: 'dev' | 'test';
  registrationNo: string;
  operatorDomains: string[];
  retention: RetentionSettings;
}

/** 넣을 행을 만든다 (DB 접근 없음). 규칙 함수가 막는 것은 넣지 않거나 낮은 상태로 넣는다. */
export async function buildDemoSeed(ctx: DemoSeedCtx): Promise<DemoSeedRows> {
  const ts = ctx.now;
  const ago = (days: number) => ts - days * DAY;

  // 기업: 예시 서류 행은 "확인을 마친 기업으로 보일" 기업에만 둔다. 검증 상태는 verifyBlocks 가 정한다.
  const docs = DEMO_COMPANIES.filter((c) => c.wantVerified).map((c) => ({
    id: demoId(6, companyNo(c)), company_id: c.id, doc_type: docTypeOf(c), r2_key: demoDocKey(c), reviewed_at: ago(30),
  }));
  const companies: DemoCompanyRow[] = DEMO_COMPANIES.map((c) => {
    const docTypes = docs.filter((d) => d.company_id === c.id).map((d) => d.doc_type);
    const verified = c.wantVerified && verifyBlocks({ entity_type: c.entity_type, biz_no: c.biz_no, docTypes }).length === 0;
    return {
      id: c.id, name_ko: c.name_ko, name_zh: c.name_zh, biz_no: c.biz_no, entity_type: c.entity_type, hq_name: c.hq_name, entry_stage: c.entry_stage,
      industry: c.industry, profile_ko: c.profile_ko, verify_status: verified ? 'verified' : 'pending', verified_at: verified ? ago(30) : null,
    };
  });
  const verifiedIds = new Set(companies.filter((c) => c.verify_status === 'verified').map((c) => c.id));

  // 공고: 게재는 publishBlocks 가 빈 배열일 때만.
  const jobs: DemoJobRow[] = DEMO_JOBS.map((j) => {
    const localized = j.title_ko !== null && j.body_ko !== null;
    const review_flag = techLeakFlag(flagText({ title_zh: j.title_zh, source_zh: j.source_zh, title_ko: j.title_ko, body_ko: j.body_ko }));
    const localize_status = localized ? 'approved' as const : 'draft' as const;
    const blocks = publishBlocks(publishInputOf(
      {
        job_family: 'office', title_ko: j.title_ko, body_ko: j.body_ko, localize_status, contact_email: j.contact_email,
        salary_basis: j.salary_basis, salary_min: j.salary_min, agency_id: null, review_flag, review_cleared_by: null,
      },
      { companyVerified: verifiedIds.has(j.companyId), flags: ctx.flags, appEnv: ctx.appEnv, registrationNo: ctx.registrationNo, operatorDomains: ctx.operatorDomains },
    ));
    // 마감한 공고도 게재된 적이 있는 공고다 — 게재할 수 없는 내용이면 초안으로 둔다.
    const status = j.want === 'draft' || blocks.length ? 'draft' as const : j.want;
    const closes = j.closesInDays === null ? null : parseKstDate(kstDate(ts + j.closesInDays * DAY));
    return {
      id: j.id, company_id: j.companyId, created_by: j.createdBy, title_zh: j.title_zh, source_zh: j.source_zh, title_ko: j.title_ko, body_ko: j.body_ko,
      localize_status, role_category: j.role_category, industry: j.industry, location: j.location, salary_min: j.salary_min, salary_max: j.salary_max,
      salary_basis: j.salary_basis, work_hours: j.work_hours, report_line: j.report_line, chinese_level: j.chinese_level, contact_email: j.contact_email,
      review_flag, status, published_at: status === 'draft' ? null : ago(j.postedDaysAgo), closes_at: status === 'published' ? closes : null,
      created_at: ago(j.postedDaysAgo + 1),
    };
  });
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // 이력서
  const bodyOf = (r: (typeof DEMO_RESUMES)[number]): ResumeBody => ({ v: 1, ...r.body, file: null });
  const resumes = await Promise.all(DEMO_RESUMES.map(async (r) => ({
    id: r.id, user_id: r.userId, title: r.title, is_default: r.isDefault, body: await sealResume(ctx.encKey, bodyOf(r)),
  })));
  const resumeById = new Map(DEMO_RESUMES.map((r) => [r.id, r]));

  // 지원: applyBlocks 가 빈 배열일 때만. 상태는 이벤트에서 나온다.
  const keepDays = ctx.retention.application_keep_days;
  const applications: DemoApplicationRow[] = [];
  const events: DemoSeedRows['events'] = [];
  const accessLogs: DemoSeedRows['accessLogs'] = [];
  const crossBorderConsents: DemoSeedRows['crossBorderConsents'] = [];
  let seq = 0;
  for (const a of DEMO_APPLICATIONS) {
    const job = jobById.get(a.jobId);
    const resume = resumeById.get(a.resumeId);
    const seeker = DEMO_USERS.find((u) => u.id === a.seekerId);
    if (!job || !resume || !seeker || resume.userId !== a.seekerId) continue;
    const members = DEMO_COMPANIES.find((c) => c.id === job.company_id)?.members ?? [];
    const need = consentNeed({ hqMembers: members.filter((m) => m.is_hq === 1).length, localMembers: members.filter((m) => m.is_hq === 0).length });
    // 시연 이력서는 모두 한국어로 쓴 것이다 (resumes.lang · applications.resume_lang 은 기본값 'ko').
    const snapshot = buildSnapshot(bodyOf(resume), resume.body, { include: false, copied: false }, 'ko');
    const blocks = applyBlocks({
      canApply: seeker.role === 'seeker', jobVisible: job.status === 'published' && verifiedIds.has(job.company_id), alreadyApplied: false,
      resumeReady: resumeReadyToApply(snapshot), consentNeed: need, consentGiven: a.consent,
    });
    if (blocks.length) continue;
    const created = ago(a.daysAgo);
    const consent = consentAt(need, a.consent, created);
    let status: AppStatus = 'submitted';
    let changed = created;
    for (const e of a.events) {
      // 이벤트를 낸 사람은 그 기업의 담당자여야 한다 (다른 기업 담당자의 이벤트는 넣지 않는다).
      if (!members.some((m) => m.userId === e.actorId)) continue;
      const at = Math.max(created, ago(e.daysAgo));
      const next = nextStatus(status, e.event);
      seq += 1;
      events.push({ id: demoId(8, seq), application_id: a.id, event: e.event, actor_id: e.actorId, at });
      if (e.event === 'viewed') accessLogs.push({ id: demoId(8, 1000 + seq), actor_id: e.actorId, target_id: a.id, at });
      if (next !== status) { status = next; changed = at; }
    }
    applications.push({
      id: a.id, job_id: a.jobId, seeker_id: a.seekerId, resume_id: a.resumeId, resume_snapshot: await sealResume(ctx.encKey, snapshot),
      cross_border_consent_at: consent, status, status_changed_at: changed, created_at: created, keep_days: keepDays,
    });
    if (consent !== null) {
      crossBorderConsents.push({ id: demoId(7, Number(a.id.slice(-12))), user_id: a.seekerId, version: crossBorderVersion(keepDays), ref_id: a.id, agreed_at: consent });
    }
  }

  return {
    now: ts,
    users: DEMO_USERS.map((u) => ({ id: u.id, email: u.email, role: u.role, locale: u.locale })),
    companies,
    members: DEMO_COMPANIES.flatMap((c) => c.members.map((m) => ({ company_id: c.id, user_id: m.userId, member_role: m.member_role, is_hq: m.is_hq }))),
    docs, jobs, resumes, applications, events, accessLogs, crossBorderConsents,
    requiredConsents: requiredConsents(ctx.retention),
    stampKey: DEMO_STAMP_KEY,
    stampValue: JSON.stringify({ v: DEMO_SEED_VERSION, at: ts }),
  };
}

/** 예시 서류 한 장짜리 PDF (실제 서류가 아님을 적어 둔다). 외부 글꼴·도구 없이 바이트를 직접 만든다. */
export function demoDocPdf(): Uint8Array {
  const text = 'DEMO DOCUMENT - not a real certificate. Sample data for the test server.';
  const stream = `BT /F1 12 Tf 60 760 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** 시연 데이터를 원래 모습으로 만든다. 꺼져 있으면 아무것도 하지 않고 false. */
export async function seedDemo(env: Env): Promise<boolean> {
  if (!demoEnabled(env) || env.APP_ENV === 'production') return false;
  const ts = now();
  const rows = await buildDemoSeed({
    now: ts, encKey: await importEncKey(env.ENC_KEY), flags: flagsOf(env), appEnv: env.APP_ENV, registrationNo: env.REGISTRATION_NO ?? '',
    operatorDomains: parseOperatorDomains(env.OPERATOR_DOMAINS ?? ''), retention: await loadRetention(env.DB),
  });
  // 방문자가 시연 기업 계정으로 올린 서류 파일은 행을 지우기 전에 키를 모아 둔다 (지운 뒤에는 찾을 수 없다).
  const extraKeys = await listExtraDemoDocKeys(env.DB, rows.companies.map((c) => c.id), rows.docs.map((d) => d.id));
  await applyDemoSeed(env.DB, rows);
  // DB 를 먼저 고치고 그다음 R2 (lib/maintenance.ts 와 같은 순서). R2 가 실패해도 로그인은 막지 않는다 — 다음 되돌리기 때 다시 한다.
  try {
    const pdf = demoDocPdf();
    await Promise.all(rows.docs.map((d) => env.FILES.put(d.r2_key, pdf, { httpMetadata: { contentType: 'application/pdf' } })));
    await Promise.all(extraKeys.map((k) => env.FILES.delete(k)));
  } catch {
    console.error('demo: file step failed');
  }
  return true;
}

export type DemoLoginResult = { ok: true; user: SessionUser; token: string; maxAge: number } | { ok: false };

/**
 * 시연 계정으로 로그인시킨다. key 는 lib/demo.DEMO_ACCOUNTS 의 이름이어야 한다 (그 밖의 값·꺼져 있을 때는 실패).
 * 필요하면 먼저 시연 데이터를 넣거나 되돌린다. 관리자 세션은 여기서 절대 만들어지지 않는다.
 */
export async function demoLogin(env: Env, key: string): Promise<DemoLoginResult> {
  if (!demoEnabled(env)) return { ok: false };
  const acct = findDemoAccount(key);
  if (!acct || !isDemoUserId(acct.userId)) return { ok: false };
  const usable = (u: { role: string; status: string } | null): boolean => !!u && u.status === 'active' && u.role === acct.role;
  let user = await findDemoUser(env.DB, acct.userId);
  const stamp = parseDemoStamp(await getSetting(env.DB, DEMO_STAMP_KEY));
  if (demoSeedDue(stamp, now()) || !usable(user)) {
    await seedDemo(env);
    user = await findDemoUser(env.DB, acct.userId);
  }
  if (!user || !usable(user) || (user.role !== 'seeker' && user.role !== 'company')) return { ok: false };
  const su: SessionUser = { id: user.id, email: user.email, role: user.role, locale: user.locale === 'zh' ? 'zh' : 'ko' };
  // mfa = false: 시연 세션은 TOTP 를 통과한 세션이 아니다 (lib/auth.sessionUsable).
  const { token, maxAge } = await createSession(env, su, false);
  return { ok: true, user: su, token, maxAge };
}
