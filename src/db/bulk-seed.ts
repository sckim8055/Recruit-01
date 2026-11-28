// 대량 테스트 데이터 넣기·지우기의 SQL (T-21, 테스트 서버·로컬 개발 전용 — 호출부 lib/bulk-seed.ts 가 APP_ENV 를 먼저 확인한다).
// 판단은 하지 않는다: 게재 여부(rules.publishBlocks)·검증 상태(rules.verifyBlocks)·지원 상태(rules.nextStatus)·암호문(lib/resume.sealResume)은 호출부가 정해서 넘긴다.
// 게재·마감·차단·지원·지원 이벤트는 이 파일이 아니라 앱이 쓰는 함수 그대로 한다
// (db/jobs.publishJob·closeJob·blockJob, db/applications.insertApplication·withdrawApplication, db/applicants.markViewed·recordMailEvent).
//
// 대량 데이터 표시: 이 파일이 넣는 행의 id 는 모두 `b5eed00<종류>-0000-4000-8000-<12자리 번호>` 모양이다 (lib/bulk-seed.bulkId).
// 지우기는 그 id 모양(LIKE 패턴, 호출부가 BulkLike 로 넘긴다)과, 그 행을 외래키로 가리키는 행만 지운다 — 다른 행은 읽지도 쓰지도 않는다.
// 앱 함수가 만든 행(지원 이벤트·국외 이전 동의 등)은 id 가 무작위지만 대량 지원·회원을 가리키므로 같이 지워진다.
//
// [pg] batch = 한 트랜잭션 (db/pg.ts). 한 batch 에 문장을 CHUNK 개까지 넣는다 (메모리·트랜잭션 크기를 묶어 둔다).
import type { Db, DbStatement } from './types';

/** 종류별 id 의 LIKE 패턴 (예: 'b5eed001-0000-4000-8000-%'). lib/bulk-seed.bulkLike 가 만든다. */
export interface BulkLike { user: string; company: string; job: string; resume: string; application: string; doc: string; consent: string; access: string }

export interface BulkUserRow { id: string; email: string; role: 'seeker' | 'company'; locale: 'ko' | 'zh'; created_at: number }
export interface BulkConsentRow { id: string; user_id: string; type: 'terms' | 'privacy'; version: string; agreed_at: number }
export interface BulkCompanyRow {
  id: string; name_ko: string; name_zh: string; biz_no: string | null; entity_type: 'kr_entity' | 'cn_hq'; hq_name: string; entry_stage: string;
  industry: string; profile_ko: string; verify_status: 'pending' | 'verified' | 'rejected'; verified_at: number | null; reject_reason: string | null; created_at: number;
}
export interface BulkMemberRow { company_id: string; user_id: string; member_role: 'owner' | 'member'; is_hq: 0 | 1; created_at: number }
export interface BulkDocRow {
  id: string; company_id: string; doc_type: 'biz_cert' | 'cn_license'; r2_key: string; review_status: 'pending' | 'approved' | 'rejected';
  reviewed_at: number | null; created_at: number;
}
/** 공고는 모두 초안(status = 'draft', rev = 0)으로 넣는다. 게재는 호출부가 publishBlocks 를 거쳐 db/jobs.publishJob 으로 한다. */
export interface BulkJobRow {
  id: string; company_id: string; created_by: string; title_zh: string; source_zh: string; title_ko: string | null; body_ko: string | null;
  localize_status: 'draft' | 'review' | 'approved'; role_category: string; industry: string; location: string;
  salary_min: number | null; salary_max: number | null; salary_basis: string | null; work_hours: string | null; report_line: string; chinese_level: string;
  contact_email: string; review_flag: string | null; closes_at: number | null; created_at: number; updated_at: number;
}
export interface BulkResumeRow { id: string; user_id: string; title: string; is_default: 0 | 1; body: string; file_r2_key: string | null; created_at: number; updated_at: number }
export interface BulkAccessRow { id: string; actor_id: string; actor_role: 'company'; target_id: string; at: number }

export interface BulkBaseRows {
  users: BulkUserRow[];
  consents: BulkConsentRow[];
  companies: BulkCompanyRow[];
  members: BulkMemberRow[];
  docs: BulkDocRow[];
}

const CHUNK = 250;

/** 문장 목록을 CHUNK 개씩 나눠 batch (트랜잭션) 로 보낸다. */
async function inChunks(db: Db, stmts: DbStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += CHUNK) await db.batch(stmts.slice(i, i + CHUNK));
}

// ── 넣기

/** 회원·필수 동의·기업·담당자·검증 서류 행. 회원의 role 은 seeker·company 뿐이다 (관리자를 만드는 문장은 이 파일에 없다). */
export async function insertBulkBase(db: Db, s: BulkBaseRows): Promise<void> {
  await inChunks(db, [
    ...s.users.map((u) => db.prepare(
      "INSERT INTO users (id, email, role, locale, status, created_at) VALUES (?,?,?,?,'active',?)",
    ).bind(u.id, u.email, u.role, u.locale, u.created_at)),
    ...s.consents.map((c) => db.prepare(
      'INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?,?,?,?,NULL,?)',
    ).bind(c.id, c.user_id, c.type, c.version, c.agreed_at)),
    // verify_status 는 호출부가 rules.verifyBlocks 로 정한 값이다.
    ...s.companies.map((c) => db.prepare(
      `INSERT INTO companies (id, name_ko, name_zh, biz_no, entity_type, hq_name, entry_stage, industry, website, profile_ko, verify_status, verified_at, created_at, reject_reason)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)`,
    ).bind(c.id, c.name_ko, c.name_zh, c.biz_no, c.entity_type, c.hq_name, c.entry_stage, c.industry, c.profile_ko, c.verify_status, c.verified_at, c.created_at, c.reject_reason)),
    ...s.members.map((m) => db.prepare(
      'INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES (?,?,?,?,?)',
    ).bind(m.company_id, m.user_id, m.member_role, m.is_hq, m.created_at)),
    ...s.docs.map((d) => db.prepare(
      `INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_by, reviewed_at, created_at)
       VALUES (?, 'company', ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(d.id, d.company_id, d.doc_type, d.r2_key, d.review_status, d.reviewed_at, d.created_at)),
  ]);
}

/** 공고 (모두 초안, rev 0, published_at NULL). */
export async function insertBulkJobs(db: Db, jobs: BulkJobRow[]): Promise<void> {
  await inChunks(db, jobs.map((j) => db.prepare(
    `INSERT INTO jobs (id, company_id, agency_id, created_by, job_family, title_zh, source_zh, title_ko, body_ko, back_zh, localize_status,
       role_category, industry, location, salary_min, salary_max, salary_basis, work_hours, report_line, chinese_level, contact_email,
       company_name_public, review_flag, review_cleared_by, status, block_reason, published_at, closes_at, created_at, updated_at, rev)
     VALUES (?,?,NULL,?,'office',?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,'draft',NULL,NULL,?,?,?,0)`,
  ).bind(
    j.id, j.company_id, j.created_by, j.title_zh, j.source_zh, j.title_ko, j.body_ko, j.localize_status,
    j.role_category, j.industry, j.location, j.salary_min, j.salary_max, j.salary_basis, j.work_hours, j.report_line, j.chinese_level, j.contact_email,
    j.review_flag, j.closes_at, j.created_at, j.updated_at,
  )));
}

/** 이력서 (body 는 sealResume 암호문, 첨부 키는 호출부가 파일을 먼저 저장한 뒤 넘긴다). */
export async function insertBulkResumes(db: Db, resumes: BulkResumeRow[]): Promise<void> {
  await inChunks(db, resumes.map((r) => db.prepare(
    'INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).bind(r.id, r.user_id, r.title, r.is_default, r.body, r.file_r2_key, r.created_at, r.updated_at)));
}

/** 기업 담당자가 지원서를 연 기록 (lib/applicants.openApplication 이 남기는 것과 같은 모양: 역할 company, 사유 없음). */
export async function insertBulkAccessLogs(db: Db, logs: BulkAccessRow[]): Promise<void> {
  await inChunks(db, logs.map((l) => db.prepare(
    "INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES (?, ?, ?, 'application', ?, NULL, ?)",
  ).bind(l.id, l.actor_id, l.actor_role, l.target_id, l.at)));
}

/** 마감한 대량 공고에 지난 마감일을 적는다 (마감 자체는 db/jobs.closeJob 으로 한 뒤). 대량 공고·마감 상태일 때만. */
export async function setBulkClosedDeadlines(db: Db, p: BulkLike, rows: Array<{ id: string; closes_at: number }>): Promise<void> {
  await inChunks(db, rows.map((r) => db.prepare(
    "UPDATE jobs SET closes_at = ? WHERE id = ? AND id LIKE ? AND status = 'closed'",
  ).bind(r.closes_at, r.id, p.job)));
}

/** 넣은 기록 (site_settings 한 행, 누가 = NULL). */
export async function writeBulkStamp(db: Db, key: string, value: string, ts: number): Promise<void> {
  await db.prepare(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,NULL,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = NULL, updated_at = excluded.updated_at`,
  ).bind(key, value, ts).run();
}

// ── 세기·지우기

/** 대량 지원 집합: 대량 id 의 지원 + 대량 구직자의 지원 + 대량 공고에 달린 지원(다른 회원의 것 포함 — 공고를 지우려면 함께 지워야 한다). */
const APPS = 'applications WHERE id LIKE ? OR seeker_id LIKE ? OR job_id LIKE ?';
const APPS_WITH_FILE = 'applications WHERE file_r2_key IS NOT NULL AND (id LIKE ? OR seeker_id LIKE ? OR job_id LIKE ?)';
const appBinds = (p: BulkLike) => [p.application, p.user, p.job];

export interface BulkCounts {
  users: number; consents: number; companies: number; members: number; docs: number; jobs: number;
  jobs_published: number; jobs_draft: number; jobs_closed: number; jobs_blocked: number;
  resumes: number; resume_files: number; applications: number; application_files: number; foreign_applications: number;
  events: number; access_log: number; email_log: number;
}

/** 지금 DB 에 있는 대량 데이터의 개수 (이름·내용은 읽지 않는다). emailHashes = 대량 회원 주소의 해시 (email_log 를 센다). */
export async function countBulk(db: Db, p: BulkLike, emailHashes: string[]): Promise<BulkCounts> {
  const hq = emailHashes.length ? emailHashes.map(() => '?').join(',') : "''";
  const r = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE id LIKE ?) AS users,
       (SELECT COUNT(*) FROM consents WHERE user_id LIKE ? OR (type = 'cross_border' AND ref_id IN (SELECT id FROM ${APPS}))) AS consents,
       (SELECT COUNT(*) FROM companies WHERE id LIKE ?) AS companies,
       (SELECT COUNT(*) FROM company_members WHERE company_id LIKE ? OR user_id LIKE ?) AS members,
       (SELECT COUNT(*) FROM verification_docs WHERE owner_type = 'company' AND owner_id LIKE ?) AS docs,
       (SELECT COUNT(*) FROM jobs WHERE id LIKE ? OR company_id LIKE ?) AS jobs,
       (SELECT COUNT(*) FROM jobs WHERE id LIKE ? AND status = 'published') AS jobs_published,
       (SELECT COUNT(*) FROM jobs WHERE id LIKE ? AND status = 'draft') AS jobs_draft,
       (SELECT COUNT(*) FROM jobs WHERE id LIKE ? AND status = 'closed') AS jobs_closed,
       (SELECT COUNT(*) FROM jobs WHERE id LIKE ? AND status = 'blocked') AS jobs_blocked,
       (SELECT COUNT(*) FROM resumes WHERE user_id LIKE ?) AS resumes,
       (SELECT COUNT(*) FROM resumes WHERE user_id LIKE ? AND file_r2_key IS NOT NULL) AS resume_files,
       (SELECT COUNT(*) FROM ${APPS}) AS applications,
       (SELECT COUNT(*) FROM ${APPS_WITH_FILE}) AS application_files,
       (SELECT COUNT(*) FROM applications WHERE job_id LIKE ? AND seeker_id NOT LIKE ?) AS foreign_applications,
       (SELECT COUNT(*) FROM application_events WHERE application_id IN (SELECT id FROM ${APPS}) OR actor_id LIKE ?) AS events,
       (SELECT COUNT(*) FROM access_log WHERE actor_id LIKE ?
          OR (target_type = 'application' AND target_id IN (SELECT id FROM ${APPS}))
          OR (target_type = 'resume' AND target_id IN (SELECT id FROM resumes WHERE user_id LIKE ?))
          OR (target_type = 'verification_doc' AND target_id IN (SELECT id FROM verification_docs WHERE owner_type = 'company' AND owner_id LIKE ?))) AS access_log,
       (SELECT COUNT(*) FROM email_log WHERE to_hash IN (${hq})) AS email_log`,
  ).bind(
    p.user, p.user, ...appBinds(p), p.company, p.company, p.user, p.company, p.job, p.company, p.job, p.job, p.job, p.job, p.user, p.user,
    ...appBinds(p), ...appBinds(p), p.job, p.user, ...appBinds(p), p.user, p.user, ...appBinds(p), p.user, p.company, ...emailHashes,
  ).first<Record<keyof BulkCounts, number>>();
  const out = {} as BulkCounts;
  for (const [k, v] of Object.entries(r ?? {})) (out as unknown as Record<string, number>)[k] = Number(v ?? 0);
  return out;
}

/** 대량 회원의 로그인 주소 (email_log 의 주소 해시를 만들려고 읽는다 — 호출부는 화면·로그에 내보내지 않는다). */
export async function listBulkUserEmails(db: Db, p: BulkLike): Promise<string[]> {
  return (await db.prepare('SELECT email FROM users WHERE id LIKE ?').bind(p.user).all<{ email: string }>()).results.map((r) => r.email);
}

/** 지울 파일 키: 대량 이력서·지원서 첨부, 대량 기업의 검증 서류. 행을 지우기 전에 읽는다 (지운 뒤에는 찾을 수 없다). */
export async function listBulkFileKeys(db: Db, p: BulkLike): Promise<string[]> {
  const r = await db.prepare(
    `SELECT file_r2_key AS k FROM resumes WHERE user_id LIKE ? AND file_r2_key IS NOT NULL
     UNION ALL SELECT file_r2_key FROM ${APPS_WITH_FILE}
     UNION ALL SELECT r2_key FROM verification_docs WHERE owner_type = 'company' AND owner_id LIKE ?`,
  ).bind(p.user, ...appBinds(p), p.company).all<{ k: string }>();
  return r.results.map((x) => x.k);
}

/**
 * 대량 데이터와 그것을 가리키는 행을 한 트랜잭션으로 지운다 (자식 먼저). 표마다 지운 행 수를 돌려준다.
 * 지우는 것 (모두 대량 id 패턴이거나, 대량 행을 가리키는 행):
 *   조건 알림·해지 토큰(대량 구직자) · 지원 이벤트(대량 지원 집합, 대량 회원이 낸 것) · 열람 기록(대량 회원이 연 것, 대량 지원서·이력서·서류를 연 것)
 *   · 동의(대량 회원, 대량 지원의 국외 이전) · 지원(대량 지원 집합) · 이력서 · 공고(대량 id, 대량 기업) · 검증 서류 · 초대 · 담당자 · 기업
 *   · 세션·2단계 대기·복구 코드·관리자 기록(대상이 대량 회원) · 구직자 프로필·헤드헌터 소속·신고(대량 회원) · 인증코드·메일 기록(대량 주소)
 *   · 하루 사용량(대량 기업) · 회원 · 넣은 기록(stampKey)
 * 대량 회원이 아닌 회원·기업·공고 행 자체는 지우지 않는다. 다른 회원이 대량 공고에 낸 지원은 공고와 함께 지운다(외래키 — 호출부가 개수를 알린다).
 */
export async function deleteBulkRows(db: Db, p: BulkLike, emailHashes: string[], mailDomainLike: string, stampKey: string): Promise<Record<string, number>> {
  const hq = emailHashes.length ? emailHashes.map(() => '?').join(',') : "''";
  const plan: Array<[string, DbStatement]> = [
    ['alert_unsub_tokens', db.prepare('DELETE FROM alert_unsub_tokens WHERE alert_id IN (SELECT id FROM alerts WHERE seeker_id LIKE ?)').bind(p.user)],
    ['alerts', db.prepare('DELETE FROM alerts WHERE seeker_id LIKE ?').bind(p.user)],
    ['application_events', db.prepare(`DELETE FROM application_events WHERE application_id IN (SELECT id FROM ${APPS}) OR actor_id LIKE ?`).bind(...appBinds(p), p.user)],
    ['access_log', db.prepare(
      `DELETE FROM access_log WHERE actor_id LIKE ?
         OR (target_type = 'application' AND target_id IN (SELECT id FROM ${APPS}))
         OR (target_type = 'resume' AND target_id IN (SELECT id FROM resumes WHERE user_id LIKE ?))
         OR (target_type = 'verification_doc' AND target_id IN (SELECT id FROM verification_docs WHERE owner_type = 'company' AND owner_id LIKE ?))`,
    ).bind(p.user, ...appBinds(p), p.user, p.company)],
    ['consents', db.prepare(`DELETE FROM consents WHERE user_id LIKE ? OR (type = 'cross_border' AND ref_id IN (SELECT id FROM ${APPS}))`).bind(p.user, ...appBinds(p))],
    ['applications', db.prepare(`DELETE FROM ${APPS}`).bind(...appBinds(p))],
    ['resumes', db.prepare('DELETE FROM resumes WHERE user_id LIKE ?').bind(p.user)],
    ['jobs', db.prepare('DELETE FROM jobs WHERE id LIKE ? OR company_id LIKE ?').bind(p.job, p.company)],
    ['verification_docs', db.prepare("DELETE FROM verification_docs WHERE owner_type = 'company' AND owner_id LIKE ?").bind(p.company)],
    ['company_invites', db.prepare('DELETE FROM company_invites WHERE company_id LIKE ? OR invited_by LIKE ?').bind(p.company, p.user)],
    ['company_members', db.prepare('DELETE FROM company_members WHERE company_id LIKE ? OR user_id LIKE ?').bind(p.company, p.user)],
    ['companies', db.prepare('DELETE FROM companies WHERE id LIKE ?').bind(p.company)],
    ['totp_recovery_codes', db.prepare('DELETE FROM totp_recovery_codes WHERE user_id LIKE ?').bind(p.user)],
    ['totp_enrolments', db.prepare('DELETE FROM totp_enrolments WHERE user_id LIKE ?').bind(p.user)],
    ['admin_totp_pending', db.prepare('DELETE FROM admin_totp_pending WHERE user_id LIKE ?').bind(p.user)],
    ['sessions', db.prepare('DELETE FROM sessions WHERE user_id LIKE ?').bind(p.user)],
    ['admin_actions', db.prepare('DELETE FROM admin_actions WHERE target_user_id LIKE ?').bind(p.user)],
    ['seeker_profiles', db.prepare('DELETE FROM seeker_profiles WHERE user_id LIKE ?').bind(p.user)],
    ['agency_members', db.prepare('DELETE FROM agency_members WHERE user_id LIKE ?').bind(p.user)],
    ['reports', db.prepare('DELETE FROM reports WHERE reporter_id LIKE ?').bind(p.user)],
    ['auth_codes', db.prepare('DELETE FROM auth_codes WHERE email LIKE ?').bind(mailDomainLike)],
    ['email_log', db.prepare(`DELETE FROM email_log WHERE to_hash IN (${hq})`).bind(...emailHashes)],
    ['usage_counters', db.prepare('DELETE FROM usage_counters WHERE subject LIKE ?').bind(p.company)],
    ['users', db.prepare('DELETE FROM users WHERE id LIKE ?').bind(p.user)],
    ['site_settings', db.prepare('DELETE FROM site_settings WHERE key = ?').bind(stampKey)],
  ];
  const res = await db.batch(plan.map(([, s]) => s));
  return Object.fromEntries(plan.map(([t], i) => [t, res[i]?.meta.changes ?? 0]));
}
