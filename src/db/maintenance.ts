// 예약 작업(T-12)의 SQL. 판단(어느 행을 언제 지우는지, 상태 계산)은 lib/maintenance.ts·lib/retention.ts 가 하고, 여기는 받은 값으로 SQL 만 실행한다.
//
// 원칙 — 이 파일의 문장은 데이터를 지운다:
// - 모든 UPDATE·DELETE 는 (1) 호출부가 넘긴 시각(now 또는 기한)으로 거는 시간 조건, (2) 행 수 한도(LIMIT, 필요하면 `id IN (SELECT … LIMIT ?)`),
//   (3) 무엇을 지우는지 적은 주석을 가진다. 조건 없는 DELETE 는 없다.
// - 같은 문장을 두 번 실행해도 더 바뀌지 않는다 (조건이 "아직 처리 전" 을 포함한다).
// - 지원 상태는 이벤트와 함께만 바뀐다 (CLAUDE.md 규칙 3): 이벤트를 넣는 문장과 상태를 바꾸는 문장을 한 batch 에 두고,
//   상태 문장은 방금 넣은 이벤트가 있을 때만 바뀐다 (db/applicants.recordMailEvent 와 같은 방식).
//
// [sqlite] batch = 한 트랜잭션, meta.changes = rowCount (PostgreSQL: BEGIN … COMMIT, 순서 그대로).
// [sqlite] 이벤트 id 를 lower(hex(randomblob(16))) 로 SQL 안에서 만든다 (db/account.eraseUser 와 같다. PostgreSQL: gen_random_uuid()::text).
// [sqlite] `x IN (SELECT … LIMIT ?)` 로 행 수를 제한한다 (SQLite 는 DELETE/UPDATE … LIMIT 을 기본으로 지원하지 않는다). PostgreSQL 도 같은 문법이 된다.
// [sqlite] substr(key, 1, n) = '접두어' 로 접두어를 비교한다 (LIKE 를 쓰지 않는다 — '_' 가 와일드카드라서). PostgreSQL 도 substr 이 있다.
// [sqlite] COUNT(*) 는 숫자로 온다 — 호출부가 Number() 로 감싼다.
// [sqlite] 바인딩 수는 문장당 100개 이하 (D1 한도). IN 목록은 호출부가 50개 이하로 나눈다.

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

// ───────── 1. 공고 자동 마감

/**
 * 마감일(closes_at)이 지난 게재 중 공고를 마감한다 (공개 조건은 closes_at > 지금 이므로 이미 목록에서 빠져 있다).
 * 지우는 것: 없음. 바꾸는 것: status 'published' → 'closed', updated_at = now. 초안·차단 공고는 건드리지 않는다.
 */
export async function closeJobsPastDeadline(db: D1Database, x: { now: number; limit: number }): Promise<number> {
  const r = await db.prepare(
    `UPDATE jobs SET status = 'closed', updated_at = ?
     WHERE id IN (SELECT id FROM jobs WHERE status = 'published' AND closes_at IS NOT NULL AND closes_at <= ? ORDER BY closes_at, id LIMIT ?)
       AND status = 'published' AND closes_at IS NOT NULL AND closes_at <= ?`,
  ).bind(x.now, x.now, x.limit, x.now).run();
  return r.meta.changes;
}

/**
 * 마감일이 없고 오래 저장되지 않은 게재 중 공고를 마감한다.
 * 조건: 마지막 저장(updated_at)이 staleBefore 보다 이전 + 안내 메일을 noticeBefore 이전에 보냈음(안내 후 3일이 지남).
 * 지우는 것: 없음. 바꾸는 것: status 'published' → 'closed', updated_at = now. 초안·차단 공고는 건드리지 않는다.
 */
export async function closeStaleJobs(
  db: D1Database, x: { now: number; staleBefore: number; noticeBefore: number; limit: number },
): Promise<number> {
  const cond = `status = 'published' AND closes_at IS NULL AND updated_at < ? AND close_notice_at IS NOT NULL AND close_notice_at <= ?`;
  const r = await db.prepare(
    `UPDATE jobs SET status = 'closed', updated_at = ?
     WHERE id IN (SELECT id FROM jobs WHERE ${cond} ORDER BY updated_at, id LIMIT ?) AND ${cond}`,
  ).bind(x.now, x.staleBefore, x.noticeBefore, x.limit, x.staleBefore, x.noticeBefore).run();
  return r.meta.changes;
}

export interface CloseNoticeJobRow {
  id: string;
  company_id: string;
  title_ko: string | null;
  closes_at: number | null;
  updated_at: number;
}

/**
 * 곧 자동 마감될 게재 중 공고 (아직 안내하지 않은 것): 마감일이 (now, deadlineBefore] 안이거나, 마감일이 없고 마지막 저장이 staleBefore 이전.
 * 읽기만 한다. 개인정보 없음(공고 제목·기업 id).
 */
export async function listJobsNeedingCloseNotice(
  db: D1Database, x: { now: number; deadlineBefore: number; staleBefore: number; limit: number },
): Promise<CloseNoticeJobRow[]> {
  const r = await db.prepare(
    `SELECT id, company_id, title_ko, closes_at, updated_at FROM jobs
     WHERE status = 'published' AND close_notice_at IS NULL
       AND ((closes_at IS NOT NULL AND closes_at > ? AND closes_at <= ?) OR (closes_at IS NULL AND updated_at < ?))
     ORDER BY updated_at, id LIMIT ?`,
  ).bind(x.now, x.deadlineBefore, x.staleBefore, x.limit).all<CloseNoticeJobRow>();
  return r.results;
}

/** 기업들의 활성 담당자 주소 (db/applications.companyMemberEmails 와 같은 조건, 기업 여러 개를 한 번에). companyIds 는 50개 이하. */
export async function listActiveMemberEmails(db: D1Database, companyIds: string[]): Promise<Array<{ company_id: string; email: string }>> {
  if (!companyIds.length) return [];
  const r = await db.prepare(
    `SELECT m.company_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
     WHERE m.company_id IN (${marks(companyIds.length)}) AND u.status = 'active' ORDER BY m.company_id, m.created_at LIMIT 500`,
  ).bind(...companyIds).all<{ company_id: string; email: string }>();
  return r.results;
}

/**
 * 안내 메일을 보냈다고 표시한다. 공고마다 읽었을 때의 updated_at 이 그대로일 때만 (그사이 기업이 저장했으면 표시하지 않는다 — 저장이 기간을 새로 시작한다).
 * 지우는 것: 없음. 바꾸는 것: close_notice_at = now. jobs 는 10개 이하.
 */
export async function markCloseNoticeSent(db: D1Database, x: { now: number; jobs: Array<{ id: string; updated_at: number }> }): Promise<number> {
  if (!x.jobs.length) return 0;
  const pairs = x.jobs.map(() => '(id = ? AND updated_at = ?)').join(' OR ');
  const r = await db.prepare(
    `UPDATE jobs SET close_notice_at = ? WHERE (${pairs}) AND status = 'published' AND close_notice_at IS NULL AND updated_at <= ?`,
  ).bind(x.now, ...x.jobs.flatMap((j) => [j.id, j.updated_at]), x.now).run();
  return r.meta.changes;
}

// ───────── 2·3. 지원서 보관 기한·자동 종료·내용 삭제

/**
 * 마감·차단된 공고의 지원에 보관 기한을 붙인다 (purge_after = 마감을 확인한 때 + 180일). 취소된 지원은 이미 기한이 있다.
 * 지우는 것: 없음. 바꾸는 것: purge_after NULL → purgeAt. limit 행까지.
 */
export async function markPurgeAfter(db: D1Database, x: { now: number; purgeAt: number; limit: number }): Promise<number> {
  const r = await db.prepare(
    `UPDATE applications SET purge_after = ?
     WHERE id IN (
       SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.status IN ('closed','blocked') AND a.purge_after IS NULL AND a.status != 'withdrawn' AND a.created_at <= ?
       ORDER BY a.created_at, a.id LIMIT ?)
       AND purge_after IS NULL AND status != 'withdrawn' AND created_at <= ?`,
  ).bind(x.purgeAt, x.now, x.limit, x.now).run();
  return r.meta.changes;
}

/**
 * 차단이 풀려 다시 초안·게재 중이 된 공고의 진행 중 지원: 붙여 두었던 보관 기한을 뗀다 (기한이 아직 오지 않았고 내용이 남아 있는 것만).
 * 지우는 것: 없음. 바꾸는 것: purge_after → NULL. 끝난 지원(불합격·종료·취소)과 기한이 지난 지원은 그대로 둔다. limit 행까지.
 */
export async function unmarkPurgeAfter(db: D1Database, x: { now: number; openStatuses: string[]; limit: number }): Promise<number> {
  const m = marks(x.openStatuses.length);
  const r = await db.prepare(
    `UPDATE applications SET purge_after = NULL
     WHERE id IN (
       SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.status IN ('draft','published') AND a.purge_after IS NOT NULL AND a.purge_after > ?
         AND a.status IN (${m}) AND a.resume_snapshot != ''
       ORDER BY a.id LIMIT ?)
       AND purge_after IS NOT NULL AND purge_after > ? AND status IN (${m}) AND resume_snapshot != ''`,
  ).bind(x.now, ...x.openStatuses, x.limit, x.now, ...x.openStatuses).run();
  return r.meta.changes;
}

export interface AppStatusRow { id: string; status: string }

/**
 * 자동 종료할 지원: 마감·차단된 공고의 진행 중 지원 중 purge_after < purgeBefore (= 마감 확인 후 30일이 지남).
 * 읽기만 한다 (id·상태만, 내용 없음).
 */
export async function listAutoCloseCandidates(
  db: D1Database, x: { purgeBefore: number; openStatuses: string[]; limit: number },
): Promise<AppStatusRow[]> {
  const r = await db.prepare(
    `SELECT a.id, a.status FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE j.status IN ('closed','blocked') AND a.purge_after IS NOT NULL AND a.purge_after < ? AND a.status IN (${marks(x.openStatuses.length)})
     ORDER BY a.purge_after, a.id LIMIT ?`,
  ).bind(x.purgeBefore, ...x.openStatuses, x.limit).all<AppStatusRow>();
  return r.results;
}

/** 상태 하나에서 다른 상태로 옮길 지원 묶음. to 는 호출부가 rules.nextStatus(from, 'auto_closed') 로 계산한 값 (from 과 달라야 한다). */
export interface AutoCloseGroup { from: string; to: string; ids: string[] }

/**
 * 'auto_closed' 이벤트(actor 없음) + 상태 변경 문장 두 개. 지원이 from 상태이고 purge_after < purgeBefore 이며 공고가 마감·차단일 때만 이벤트가 들어가고,
 * 상태는 그 지원에 방금(at = now) 넣은 auto_closed 이벤트가 있을 때만 바뀐다. ids 는 50개 이하.
 * 지우는 것: 없음.
 */
function autoCloseStmts(db: D1Database, g: AutoCloseGroup, now: number, purgeBefore: number, needClosedJob: boolean): D1PreparedStatement[] {
  const m = marks(g.ids.length);
  const jobCond = needClosedJob ? `AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = a.job_id AND j.status IN ('closed','blocked'))` : '';
  return [
    db.prepare(
      `INSERT INTO application_events (id, application_id, event, actor_id, at)
       SELECT lower(hex(randomblob(16))), a.id, 'auto_closed', NULL, ? FROM applications a
       WHERE a.id IN (${m}) AND a.status = ? AND a.purge_after IS NOT NULL AND a.purge_after < ? ${jobCond}`,
    ).bind(now, ...g.ids, g.from, purgeBefore),
    db.prepare(
      `UPDATE applications SET status = ?, status_changed_at = ?
       WHERE id IN (${m}) AND status = ? AND status != ?
         AND EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = applications.id AND e.event = 'auto_closed' AND e.actor_id IS NULL AND e.at = ?)`,
    ).bind(g.to, now, ...g.ids, g.from, g.to, now),
  ];
}

/** 자동 종료 (한 batch). 돌려주는 값: 넣은 이벤트 수, 바뀐 상태 수 (둘은 같아야 한다). */
export async function autoCloseApplications(
  db: D1Database, x: { groups: AutoCloseGroup[]; now: number; purgeBefore: number },
): Promise<{ events: number; changed: number }> {
  const groups = x.groups.filter((g) => g.ids.length && g.from !== g.to);
  if (!groups.length) return { events: 0, changed: 0 };
  const res = await db.batch(groups.flatMap((g) => autoCloseStmts(db, g, x.now, x.purgeBefore, true)));
  let events = 0, changed = 0;
  res.forEach((r, i) => { if (i % 2 === 0) events += r.meta.changes; else changed += r.meta.changes; });
  return { events, changed };
}

export interface PurgeCandidateRow { id: string; status: string; file_r2_key: string | null }

/** 보관 기한(purge_after)이 지났는데 내용·파일이 남아 있는 지원 (id·상태·파일 키만). 읽기만 한다. */
export async function listPurgeCandidates(db: D1Database, x: { now: number; limit: number }): Promise<PurgeCandidateRow[]> {
  const r = await db.prepare(
    `SELECT id, status, file_r2_key FROM applications
     WHERE purge_after IS NOT NULL AND purge_after < ? AND (resume_snapshot != '' OR file_r2_key IS NOT NULL)
     ORDER BY purge_after, id LIMIT ?`,
  ).bind(x.now, x.limit).all<PurgeCandidateRow>();
  return r.results;
}

/**
 * 보관 기한이 지난 지원의 내용을 지운다 (한 batch, R2 파일은 호출부가 이 뒤에 지운다):
 * 1) 아직 진행 중인 지원은 'auto_closed' 이벤트 + 상태 (groups, 공고 상태는 보지 않는다 — 기한이 지났으면 지운다)
 * 2) 지우는 것: resume_snapshot(🔒 암호문) → '', file_r2_key → NULL, summary_zh(🔒) → NULL. purge_after < now 인 행만, ids 는 50개 이하.
 * 3) 그 지원의 국외 이전 동의(cross_border)를 철회로 표시 (withdrawn_at = now). 내용이 지워진 지원의 것만.
 */
export async function erasePurgedApplications(
  db: D1Database, x: { ids: string[]; groups: AutoCloseGroup[]; now: number },
): Promise<{ events: number; changed: number; erased: number; consents: number }> {
  if (!x.ids.length) return { events: 0, changed: 0, erased: 0, consents: 0 };
  const groups = x.groups.filter((g) => g.ids.length && g.from !== g.to);
  const m = marks(x.ids.length);
  const stmts = groups.flatMap((g) => autoCloseStmts(db, g, x.now, x.now, false));
  stmts.push(
    db.prepare(
      `UPDATE applications SET resume_snapshot = '', file_r2_key = NULL, summary_zh = NULL
       WHERE id IN (${m}) AND purge_after IS NOT NULL AND purge_after < ? AND (resume_snapshot != '' OR file_r2_key IS NOT NULL OR summary_zh IS NOT NULL)`,
    ).bind(...x.ids, x.now),
    db.prepare(
      `UPDATE consents SET withdrawn_at = ?
       WHERE type = 'cross_border' AND withdrawn_at IS NULL AND agreed_at <= ? AND ref_id IN (${m})
         AND EXISTS (SELECT 1 FROM applications a WHERE a.id = consents.ref_id AND a.seeker_id = consents.user_id
                     AND a.resume_snapshot = '' AND a.purge_after IS NOT NULL AND a.purge_after < ?)`,
    ).bind(x.now, x.now, ...x.ids, x.now),
  );
  const res = await db.batch(stmts);
  let events = 0, changed = 0;
  for (let i = 0; i < groups.length * 2; i++) {
    if (i % 2 === 0) events += res[i]!.meta.changes; else changed += res[i]!.meta.changes;
  }
  return { events, changed, erased: res[res.length - 2]!.meta.changes, consents: res[res.length - 1]!.meta.changes };
}

/**
 * 이 키들 중 지금 어느 행(이력서 resumes.file_r2_key, 지원서 applications.file_r2_key)이라도 가리키는 키. 읽기만 한다.
 * keys 는 50개 이하 (문장당 바인딩 50개 — D1 한도 100 안).
 */
export async function findReferencedFileKeys(db: D1Database, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  if (keys.length > 50) throw new Error('findReferencedFileKeys: too many keys');
  const m = marks(keys.length);
  const [a, b] = await db.batch([
    db.prepare(`SELECT file_r2_key AS k FROM resumes WHERE file_r2_key IN (${m})`).bind(...keys),
    db.prepare(`SELECT file_r2_key AS k FROM applications WHERE file_r2_key IN (${m})`).bind(...keys),
  ]);
  const out = new Set<string>();
  for (const r of [a, b]) for (const row of (r?.results ?? []) as Array<{ k: string }>) out.add(row.k);
  return out;
}

// ───────── 4. 오래된 행 지우기

export interface DropOldRowsInput {
  now: number;
  erasedBefore: number;   // now - ERASED_ROW_KEEP
  accessBefore: number;   // now - ACCESS_LOG_KEEP
  emailBefore: number;    // now - EMAIL_LOG_KEEP
  usageBefore: string;    // 이 날짜('YYYY-MM-DD', 한국 시간)보다 앞선 하루 사용량 행을 지운다 (lib/quota.USAGE_KEEP_DAYS, T-05c)
  limit: number;          // 표마다 이 행 수까지
}

export interface DropOldRowsResult {
  application_events: number; applications: number; consents: number; access_log: number; email_log: number;
  sessions: number; auth_codes: number; admin_totp_pending: number; usage_counters: number;
}

/**
 * 보관 기간이 지난 행을 지운다 (한 batch, 자식 행 먼저). 표마다 limit 행까지 — 남은 것은 다음 차례에.
 * users 행은 지우지 않는다 (jobs.created_by·access_log.actor_id 등이 가리킨다). company_invites 도 건드리지 않는다.
 */
export async function dropOldRows(db: D1Database, x: DropOldRowsInput): Promise<DropOldRowsResult> {
  // 내용이 지워진 지원: 복사본 ''·파일 키 없음·보관 기한이 erasedBefore 이전 (취소·탈퇴·보관 기한 삭제 후 2년)
  const erasedApp = `a.resume_snapshot = '' AND a.file_r2_key IS NULL AND a.purge_after IS NOT NULL AND a.purge_after < ?`;
  const res = await db.batch([
    // 지우는 것: 위 지원의 이벤트 행(application_events). 지원 행보다 먼저 (외래키).
    db.prepare(
      `DELETE FROM application_events WHERE id IN (
         SELECT e.id FROM application_events e JOIN applications a ON a.id = e.application_id WHERE ${erasedApp} LIMIT ?)`,
    ).bind(x.erasedBefore, x.limit),
    // 지우는 것: 위 지원의 행(applications) — 이벤트가 하나도 남지 않은 것만.
    db.prepare(
      `DELETE FROM applications WHERE id IN (
         SELECT a.id FROM applications a WHERE ${erasedApp}
           AND NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = a.id) LIMIT ?)`,
    ).bind(x.erasedBefore, x.limit),
    // 지우는 것: 철회된 지 2년이 지난 동의 기록(consents). 철회되지 않은(유효한) 동의는 남는다.
    db.prepare(
      `DELETE FROM consents WHERE id IN (SELECT id FROM consents WHERE withdrawn_at IS NOT NULL AND withdrawn_at < ? LIMIT ?)`,
    ).bind(x.erasedBefore, x.limit),
    // 지우는 것: 2년이 지난 열람 기록(access_log).
    db.prepare('DELETE FROM access_log WHERE id IN (SELECT id FROM access_log WHERE at < ? LIMIT ?)').bind(x.accessBefore, x.limit),
    // 지우는 것: 1년이 지난 메일 발송 기록(email_log: 주소 해시·템플릿·결과).
    db.prepare('DELETE FROM email_log WHERE id IN (SELECT id FROM email_log WHERE sent_at < ? LIMIT ?)').bind(x.emailBefore, x.limit),
    // 지우는 것: 만료된 로그인 세션(sessions).
    db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ?)').bind(x.now, x.limit),
    // 지우는 것: 만료된 로그인 인증코드(auth_codes, 코드 해시).
    db.prepare('DELETE FROM auth_codes WHERE email IN (SELECT email FROM auth_codes WHERE expires_at < ? LIMIT ?)').bind(x.now, x.limit),
    // 지우는 것: 만료된 관리자 2단계 인증 대기(admin_totp_pending).
    db.prepare('DELETE FROM admin_totp_pending WHERE id IN (SELECT id FROM admin_totp_pending WHERE expires_at < ? LIMIT ?)').bind(x.now, x.limit),
    // 지우는 것: 35일이 지난 하루 사용량(usage_counters: 범위·id·날짜·횟수, 개인정보 없음). day 는 고정 형식 'YYYY-MM-DD' 라 글자 비교 = 날짜 비교.
    // [sqlite] 기본 키가 세 컬럼이라 행 값 `(a, b, c) IN (SELECT …)` 로 한도를 건다 (SQLite 3.15+, PostgreSQL 도 된다).
    db.prepare(
      'DELETE FROM usage_counters WHERE (scope, subject, day) IN (SELECT scope, subject, day FROM usage_counters WHERE day < ? LIMIT ?)',
    ).bind(x.usageBefore, x.limit),
  ]);
  const n = (i: number) => res[i]?.meta.changes ?? 0;
  return {
    application_events: n(0), applications: n(1), consents: n(2), access_log: n(3), email_log: n(4),
    sessions: n(5), auth_codes: n(6), admin_totp_pending: n(7), usage_counters: n(8),
  };
}

// ───────── 5. 사업자 서류

export interface ExpiredDocRow { id: string; r2_key: string }

/** 확인(승인·반려)이 reviewedBefore 이전에 끝난 서류 (vdocs/ 아래 키만). 확인 대기(pending) 서류는 나오지 않는다. 읽기만 한다. */
export async function listExpiredVerificationDocs(db: D1Database, x: { reviewedBefore: number; limit: number }): Promise<ExpiredDocRow[]> {
  const r = await db.prepare(
    `SELECT id, r2_key FROM verification_docs
     WHERE review_status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewed_at < ? AND substr(r2_key, 1, 6) = 'vdocs/'
     ORDER BY reviewed_at, id LIMIT ?`,
  ).bind(x.reviewedBefore, x.limit).all<ExpiredDocRow>();
  return r.results;
}

/**
 * 지우는 것: 서류 행(verification_docs) — 확인이 reviewedBefore 이전에 끝난 것만, 행마다 한 문장(한 batch). ids 는 10개 이하.
 * 돌려주는 값: 행마다 지워졌는지. R2 객체는 호출부가 이 뒤에 지운다.
 */
export async function deleteVerificationDocRows(db: D1Database, x: { ids: string[]; reviewedBefore: number }): Promise<boolean[]> {
  if (!x.ids.length) return [];
  const res = await db.batch(x.ids.map((id) => db.prepare(
    `DELETE FROM verification_docs
     WHERE id = ? AND review_status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewed_at < ? AND substr(r2_key, 1, 6) = 'vdocs/'`,
  ).bind(id, x.reviewedBefore)));
  return res.map((r) => r.meta.changes === 1);
}

// ───────── 정리 작업의 설정값 (site_settings 의 maint.* 키)

/** 정리 작업이 쓰는 값 저장 (updated_by 없음). key 는 'maint.' 로 시작해야 한다. */
export async function putMaintSetting(db: D1Database, key: string, value: string, now: number): Promise<void> {
  if (!key.startsWith('maint.')) throw new Error('putMaintSetting: bad key');
  await db.prepare(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,NULL,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = NULL, updated_at = excluded.updated_at`,
  ).bind(key, value, now).run();
}

/** 지우는 것: 정리 작업의 설정값 한 줄 (key 는 'maint.' 로 시작, now 이전에 쓴 것). */
export async function deleteMaintSetting(db: D1Database, key: string, now: number): Promise<void> {
  await db.prepare(`DELETE FROM site_settings WHERE key = ? AND substr(key, 1, 6) = 'maint.' AND updated_at <= ?`).bind(key, now).run();
}

/** 지우는 것: 날짜가 beforeKey 보다 이른 일별 집계(maint.stats.<yyyy-mm-dd>) 줄, 마지막으로 쓴 시각이 updatedBefore 이전인 것만. limit 줄까지. */
export async function deleteOldMaintStats(db: D1Database, x: { beforeKey: string; updatedBefore: number; limit: number }): Promise<number> {
  const r = await db.prepare(
    `DELETE FROM site_settings WHERE key IN (
       SELECT key FROM site_settings WHERE substr(key, 1, 12) = 'maint.stats.' AND key < ? AND updated_at < ? LIMIT ?)`,
  ).bind(x.beforeKey, x.updatedBefore, x.limit).run();
  return r.meta.changes;
}

// ───────── 7. 하루 보고 (개수만)

export interface MaintCounts {
  usersByRole: Record<string, number>;
  publishedJobs: number;
  applicationsByStatus: Record<string, number>;
}

/** 표의 개수만 읽는다 (탈퇴한 계정은 세지 않는다). 개인정보·id 없음. */
export async function maintenanceCounts(db: D1Database): Promise<MaintCounts> {
  const [u, j, a] = await db.batch([
    db.prepare("SELECT role AS k, COUNT(*) AS n FROM users WHERE status != 'deleted' GROUP BY role"),
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'published'"),
    db.prepare('SELECT status AS k, COUNT(*) AS n FROM applications GROUP BY status'),
  ]);
  const toMap = (rows: unknown[] | undefined) => {
    const out: Record<string, number> = {};
    for (const r of (rows ?? []) as Array<{ k: string; n: number }>) out[r.k] = Number(r.n);
    return out;
  };
  return {
    usersByRole: toMap(u?.results),
    publishedJobs: Number(((j?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0),
    applicationsByStatus: toMap(a?.results),
  };
}
