// 시연 데이터 넣기·되돌리기의 SQL (테스트 서버·로컬 개발 전용 — 호출부 lib/demo-seed.ts 가 lib/demo.demoEnabled 를 먼저 확인한다).
// 판단은 하지 않는다: 어떤 값이 들어갈지(게재 상태·검증 상태·지원 상태·암호문)는 호출부가 rules.ts 등으로 정해서 넘긴다.
//
// 건드리는 범위 (이 밖의 행은 읽지도 쓰지도 않는다):
//   - id 가 고정된 시연 행 (lib/demo.demoId): 있으면 원래 값으로 덮어쓰고(ON CONFLICT … DO UPDATE), 없으면 넣는다.
//   - 시연 구직자가 만든 것: 지원·지원 이벤트·이력서·알림·동의 → 지우고 고정 행을 다시 넣는다.
//   - 시연 기업에 붙은 것: 담당자·초대·고정 목록 밖의 검증 서류와 공고 → 지운다 (다른 회원의 지원이 달린 공고는 지우지 못하므로 마감만 한다).
//   - 다른 회원(시연 계정이 아닌 방문자)이 시연 공고에 낸 지원은 그대로 둔다.
// 부모 행(users·companies·고정 공고)은 지우지 않는다 — 다른 행이 외래키로 가리키고 있을 수 있다.
//
// [sqlite] batch = 한 트랜잭션. ON CONFLICT (id) DO UPDATE … excluded 는 PostgreSQL 에서도 그대로 된다 (docs/DB-PORTING.md 3장).
// [sqlite] lower(hex(randomblob(16))) 로 동의 행 id 를 만든다 (db/account.eraseUser 와 같다. PostgreSQL: gen_random_uuid()::text).

export interface DemoUserRow { id: string; email: string; role: 'seeker' | 'company'; locale: string }
export interface DemoCompanyRow {
  id: string; name_ko: string; name_zh: string; biz_no: string | null; entity_type: string; hq_name: string; entry_stage: string;
  industry: string; profile_ko: string; verify_status: 'pending' | 'verified'; verified_at: number | null;
}
export interface DemoMemberRow { company_id: string; user_id: string; member_role: 'owner' | 'member'; is_hq: 0 | 1 }
export interface DemoDocRow { id: string; company_id: string; doc_type: string; r2_key: string; reviewed_at: number }
export interface DemoJobRow {
  id: string; company_id: string; created_by: string; title_zh: string; source_zh: string; title_ko: string | null; body_ko: string | null;
  localize_status: 'draft' | 'approved'; role_category: string; industry: string; location: string; salary_min: number | null; salary_max: number | null;
  salary_basis: string | null; work_hours: string | null; report_line: string; chinese_level: string; contact_email: string;
  review_flag: string | null; status: 'draft' | 'published' | 'closed'; published_at: number | null; closes_at: number | null; created_at: number;
}
export interface DemoResumeRow { id: string; user_id: string; title: string; is_default: 0 | 1; body: string }
export interface DemoApplicationRow {
  id: string; job_id: string; seeker_id: string; resume_id: string; resume_snapshot: string; cross_border_consent_at: number | null;
  status: string; status_changed_at: number; created_at: number; keep_days: number;
}
export interface DemoEventRow { id: string; application_id: string; event: string; actor_id: string; at: number }
export interface DemoAccessRow { id: string; actor_id: string; target_id: string; at: number }
export interface DemoConsentRow { id: string; user_id: string; version: string; ref_id: string; agreed_at: number }

export interface DemoSeedRows {
  now: number;
  users: DemoUserRow[];
  companies: DemoCompanyRow[];
  members: DemoMemberRow[];
  docs: DemoDocRow[];
  jobs: DemoJobRow[];
  resumes: DemoResumeRow[];
  applications: DemoApplicationRow[];
  events: DemoEventRow[];
  accessLogs: DemoAccessRow[];
  crossBorderConsents: DemoConsentRow[];
  /** 모든 시연 회원에게 남길 필수 동의 (지금 판의 이용약관·개인정보). */
  requiredConsents: Array<{ type: string; version: string }>;
  stampKey: string;
  stampValue: string;
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/** 시연 로그인에 쓰는 회원 한 명 (고정 id 로만 찾는다). */
export async function findDemoUser(db: D1Database, id: string): Promise<{ id: string; email: string; role: string; locale: string; status: string } | null> {
  return db.prepare('SELECT id, email, role, locale, status FROM users WHERE id = ?').bind(id)
    .first<{ id: string; email: string; role: string; locale: string; status: string }>();
}

/** 되돌릴 때 지울 검증 서류 파일: 시연 기업에 올라온 서류 중 고정 목록 밖의 것 (방문자가 시연 계정으로 올린 파일). */
export async function listExtraDemoDocKeys(db: D1Database, companyIds: string[], keepDocIds: string[]): Promise<string[]> {
  if (!companyIds.length) return [];
  const r = await db.prepare(
    `SELECT r2_key FROM verification_docs WHERE owner_type = 'company' AND owner_id IN (${marks(companyIds.length)})
       AND id NOT IN (${marks(Math.max(keepDocIds.length, 1))}) LIMIT 100`,
  ).bind(...companyIds, ...(keepDocIds.length ? keepDocIds : [''])).all<{ r2_key: string }>();
  return r.results.map((x) => x.r2_key);
}

/**
 * 시연 데이터를 원래 모습으로 만든다. 세 번의 batch(부모 → 지우기·공고 → 자식)로 나눠 보낸다 — 중간에 끊겨도 다시 실행하면 같은 결과가 된다
 * (모든 문장이 덮어쓰기이거나 "지우고 다시 넣기" 다). 마지막 batch 끝에 넣은 시각 표시(site_settings)를 남긴다.
 */
export async function applyDemoSeed(db: D1Database, s: DemoSeedRows): Promise<void> {
  const userIds = s.users.map((u) => u.id);
  const seekerIds = s.users.filter((u) => u.role === 'seeker').map((u) => u.id);
  const companyIds = s.companies.map((c) => c.id);
  const jobIds = s.jobs.map((j) => j.id);
  const docIds = s.docs.map((d) => d.id);
  const appIds = s.applications.map((a) => a.id);
  const uq = marks(userIds.length), sq = marks(seekerIds.length), cq = marks(companyIds.length), jq = marks(jobIds.length);

  // ── 1) 부모: 회원·기업·담당자·검증 서류
  await db.batch([
    // 시연 주소를 다른 회원이 쓰고 있으면(로컬 개발에서만 생길 수 있다) 비켜 놓는다 — users.email 은 고유하다.
    db.prepare(
      `UPDATE users SET email = 'displaced-' || id || '@deleted.invalid'
       WHERE email IN (${uq}) AND id NOT IN (${uq})`,
    ).bind(...s.users.map((u) => u.email), ...userIds),
    // role 은 seeker·company 만 넘어온다 (호출부의 타입). 관리자를 만들거나 관리자로 바꾸는 문장은 이 파일에 없다.
    ...s.users.map((u) => db.prepare(
      `INSERT INTO users (id, email, role, locale, status, created_at) VALUES (?,?,?,?,'active',?)
       ON CONFLICT (id) DO UPDATE SET email = excluded.email, role = excluded.role, locale = excluded.locale, status = 'active', totp_secret = NULL, totp_last_step = NULL, totp_enabled_at = NULL`,
    ).bind(u.id, u.email, u.role, u.locale, s.now)),
    ...s.companies.map((c) => db.prepare(
      `INSERT INTO companies (id, name_ko, name_zh, biz_no, entity_type, hq_name, entry_stage, industry, website, profile_ko, verify_status, verified_at, reject_reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,?)
       ON CONFLICT (id) DO UPDATE SET name_ko = excluded.name_ko, name_zh = excluded.name_zh, biz_no = excluded.biz_no, entity_type = excluded.entity_type,
         hq_name = excluded.hq_name, entry_stage = excluded.entry_stage, industry = excluded.industry, website = NULL, profile_ko = excluded.profile_ko,
         verify_status = excluded.verify_status, verified_at = excluded.verified_at, reject_reason = NULL`,
    ).bind(c.id, c.name_ko, c.name_zh, c.biz_no, c.entity_type, c.hq_name, c.entry_stage, c.industry, c.profile_ko, c.verify_status, c.verified_at, s.now)),
    // 2단계 인증의 남은 흔적 (T-18 — 시연 계정은 2단계 인증을 켤 수 없지만, 그 전에 남은 것이 있으면 지운다)
    db.prepare(`DELETE FROM totp_recovery_codes WHERE user_id IN (${uq})`).bind(...userIds),
    db.prepare(`DELETE FROM totp_enrolments WHERE user_id IN (${uq})`).bind(...userIds),
    db.prepare(`DELETE FROM admin_totp_pending WHERE user_id IN (${uq})`).bind(...userIds),
    db.prepare(`DELETE FROM company_invites WHERE company_id IN (${cq})`).bind(...companyIds),
    db.prepare(`DELETE FROM company_members WHERE company_id IN (${cq}) OR user_id IN (${uq})`).bind(...companyIds, ...userIds),
    ...s.members.map((m) => db.prepare(
      'INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES (?,?,?,?,?)',
    ).bind(m.company_id, m.user_id, m.member_role, m.is_hq, s.now)),
    db.prepare(
      `DELETE FROM verification_docs WHERE owner_type = 'company' AND owner_id IN (${cq}) AND id NOT IN (${marks(Math.max(docIds.length, 1))})`,
    ).bind(...companyIds, ...(docIds.length ? docIds : [''])),
    ...s.docs.map((d) => db.prepare(
      `INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_by, reviewed_at, created_at)
       VALUES (?, 'company', ?, ?, ?, 'approved', NULL, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, doc_type = excluded.doc_type, r2_key = excluded.r2_key,
         review_status = 'approved', reviewed_at = excluded.reviewed_at`,
    ).bind(d.id, d.company_id, d.doc_type, d.r2_key, d.reviewed_at, d.reviewed_at)),
  ]);

  // ── 2) 시연 구직자가 만든 것 지우기 + 공고
  await db.batch([
    db.prepare(`DELETE FROM application_events WHERE application_id IN (SELECT id FROM applications WHERE seeker_id IN (${sq}))`).bind(...seekerIds),
    db.prepare(`DELETE FROM applications WHERE seeker_id IN (${sq})`).bind(...seekerIds),
    db.prepare(`DELETE FROM resumes WHERE user_id IN (${sq})`).bind(...seekerIds),
    db.prepare(`DELETE FROM alert_unsub_tokens WHERE alert_id IN (SELECT id FROM alerts WHERE seeker_id IN (${sq}))`).bind(...seekerIds),
    db.prepare(`DELETE FROM alerts WHERE seeker_id IN (${sq})`).bind(...seekerIds),
    db.prepare(`DELETE FROM consents WHERE user_id IN (${uq})`).bind(...userIds),
    // 시연 기업 계정으로 방문자가 만든 공고: 다른 회원의 지원이 없으면 지우고, 있으면 마감만 한다.
    db.prepare(
      `DELETE FROM jobs WHERE company_id IN (${cq}) AND id NOT IN (${jq})
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id)`,
    ).bind(...companyIds, ...jobIds),
    db.prepare(
      `UPDATE jobs SET status = 'closed', updated_at = ? WHERE company_id IN (${cq}) AND id NOT IN (${jq}) AND status = 'published'`,
    ).bind(s.now, ...companyIds, ...jobIds),
    // status 는 호출부가 rules.publishBlocks 로 정한 값이다 (CLAUDE.md 규칙 2).
    ...s.jobs.map((j) => db.prepare(
      `INSERT INTO jobs (id, company_id, agency_id, created_by, job_family, title_zh, source_zh, title_ko, body_ko, back_zh, localize_status,
         role_category, industry, location, salary_min, salary_max, salary_basis, work_hours, report_line, chinese_level, contact_email,
         company_name_public, review_flag, review_cleared_by, status, block_reason, published_at, closes_at, created_at, updated_at, rev)
       VALUES (?,?,NULL,?,'office',?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,NULL,?,?,?,?,0)
       ON CONFLICT (id) DO UPDATE SET company_id = excluded.company_id, agency_id = NULL, created_by = excluded.created_by, job_family = 'office',
         title_zh = excluded.title_zh, source_zh = excluded.source_zh, title_ko = excluded.title_ko, body_ko = excluded.body_ko, back_zh = NULL,
         localize_status = excluded.localize_status, localize_engine = NULL, localize_requested_at = NULL,
         role_category = excluded.role_category, industry = excluded.industry, location = excluded.location,
         salary_min = excluded.salary_min, salary_max = excluded.salary_max, salary_basis = excluded.salary_basis, work_hours = excluded.work_hours,
         report_line = excluded.report_line, chinese_level = excluded.chinese_level, contact_email = excluded.contact_email, company_name_public = 1,
         review_flag = excluded.review_flag, review_cleared_by = NULL, status = excluded.status, block_reason = NULL,
         published_at = excluded.published_at, closes_at = excluded.closes_at, updated_at = excluded.updated_at, rev = rev + 1, close_notice_at = NULL`,
    ).bind(
      j.id, j.company_id, j.created_by, j.title_zh, j.source_zh, j.title_ko, j.body_ko, j.localize_status,
      j.role_category, j.industry, j.location, j.salary_min, j.salary_max, j.salary_basis, j.work_hours, j.report_line, j.chinese_level, j.contact_email,
      j.review_flag, j.status, j.published_at, j.closes_at, j.created_at, s.now,
    )),
  ]);

  // ── 3) 자식: 이력서·지원·이벤트·열람 기록·동의 + 넣은 시각 표시
  await db.batch([
    ...s.resumes.map((r) => db.prepare(
      'INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES (?,?,?,?,?,NULL,?,?)',
    ).bind(r.id, r.user_id, r.title, r.is_default, r.body, s.now, s.now)),
    ...s.applications.map((a) => db.prepare(
      `INSERT INTO applications (id, job_id, seeker_id, resume_id, resume_snapshot, file_r2_key, cross_border_consent_at, status, status_changed_at, created_at, keep_days)
       VALUES (?,?,?,?,?,NULL,?,?,?,?,?)`,
    ).bind(a.id, a.job_id, a.seeker_id, a.resume_id, a.resume_snapshot, a.cross_border_consent_at, a.status, a.status_changed_at, a.created_at, a.keep_days)),
    ...s.events.map((e) => db.prepare(
      'INSERT INTO application_events (id, application_id, event, actor_id, at) VALUES (?,?,?,?,?)',
    ).bind(e.id, e.application_id, e.event, e.actor_id, e.at)),
    // 고정 지원서의 열람 기록은 지우고 다시 넣는다 (되돌리기 전의 열람이 "열람 기록" 에 남지 않게).
    db.prepare(`DELETE FROM access_log WHERE target_type = 'application' AND target_id IN (${marks(Math.max(appIds.length, 1))})`)
      .bind(...(appIds.length ? appIds : [''])),
    ...s.accessLogs.map((l) => db.prepare(
      "INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES (?, ?, 'company', 'application', ?, NULL, ?)",
    ).bind(l.id, l.actor_id, l.target_id, l.at)),
    ...s.crossBorderConsents.map((c) => db.prepare(
      "INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at) VALUES (?, ?, 'cross_border', ?, ?, ?)",
    ).bind(c.id, c.user_id, c.version, c.ref_id, c.agreed_at)),
    ...s.requiredConsents.map((c) => db.prepare(
      `INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at)
       SELECT lower(hex(randomblob(16))), id, ?, ?, NULL, ? FROM users WHERE id IN (${uq})`,
    ).bind(c.type, c.version, s.now, ...userIds)),
    db.prepare(
      `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,NULL,?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = NULL, updated_at = excluded.updated_at`,
    ).bind(s.stampKey, s.stampValue, s.now),
  ]);
}
