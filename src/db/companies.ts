// 기업(companies)·담당자(company_members)·초대(company_invites)·검증 서류 행(verification_docs)·헤드헌터 소속(agency_members).
// 판단은 하지 않는다 — 권한은 authz.ts, 승인 조건은 rules.verifyBlocks, 편집 계획은 lib/company.ts.
// 조건부 쓰기(WHERE·EXISTS 가드)와 batch 안의 문장 순서는 옮기기 전(routes/*)과 같다. 바꾸지 않는다.
//
// [sqlite] is_hq 는 INTEGER 0/1 이다 (company_members, company_invites). 이 파일의 문장은 숫자 0/1 을 읽고 쓴다.
//          PostgreSQL 에서 BOOLEAN 으로 바꾸면 lib/actor.ts(Number(is_hq) === 1)·lib/company.ts(ownerIsHq·inviteIsHq)·화면을 같이 고친다.
// [sqlite] 여러 문장을 db.batch 로 보내는 함수는 D1 에서 한 트랜잭션이다. PostgreSQL 에서는 BEGIN … COMMIT 으로 같은 순서로 실행하고,
//          "N 번째 문장의 영향 행 수" 판단은 result.rowCount 로 한다.
// [sqlite] meta.changes(영향 행 수) → PostgreSQL 드라이버의 rowCount.
import type { CompanyFields, VerifyStatus } from '../lib/company';
import type { AdminCompanyListRow } from '../views/admin-company';
import type { DocView, InviteView, MemberView, PendingInviteView, PublicCompanyRow, PublicCompanyView } from '../views/company';

export interface MemberRow { company_id: string; member_role: 'owner' | 'member'; is_hq: number }

export interface CompanyRow extends CompanyFields {
  id: string;
  verify_status: VerifyStatus;
  verified_at: number | null;
  reject_reason: string | null;
  created_at: number;
}

export const COMPANY_COLS =
  'id, name_ko, name_zh, entity_type, biz_no, hq_name, entry_stage, industry, website, profile_ko, verify_status, verified_at, reject_reason, created_at';

// ── 소속 (lib/actor.ts loadActor, routes/biz-ctx.ts)

export interface CompanyMembershipRow { company_id: string; is_hq: number }
export interface AgencyMembershipRow { agency_id: string }

// [sqlite] is_hq 0/1 (lib/actor.ts 가 Number(is_hq) === 1 로 읽는다).
export async function listCompanyMembershipsOfUser(db: D1Database, userId: string): Promise<CompanyMembershipRow[]> {
  return (await db.prepare('SELECT company_id, is_hq FROM company_members WHERE user_id = ?')
    .bind(userId).all<CompanyMembershipRow>()).results;
}

export async function listAgencyMembershipsOfUser(db: D1Database, userId: string): Promise<AgencyMembershipRow[]> {
  return (await db.prepare('SELECT agency_id FROM agency_members WHERE user_id = ?')
    .bind(userId).all<AgencyMembershipRow>()).results;
}

/** 1차(v1)에서는 담당자 한 명이 기업 하나에만 소속된다 — 가장 먼저 생긴 소속 하나. */
export async function findFirstMembershipOfUser(db: D1Database, userId: string): Promise<MemberRow | null> {
  return db.prepare(
    'SELECT company_id, member_role, is_hq FROM company_members WHERE user_id = ? ORDER BY created_at LIMIT 1',
  ).bind(userId).first<MemberRow>();
}

export async function findCompany(db: D1Database, id: string): Promise<CompanyRow | null> {
  return db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE id = ?`)
    .bind(id).first<CompanyRow>();
}

/** 관리자 공고 상세에 붙이는 기업 이름·검증 상태. */
export async function findCompanyBrief(db: D1Database, id: string): Promise<{ name_ko: string; verify_status: string } | null> {
  return db.prepare('SELECT name_ko, verify_status FROM companies WHERE id = ?').bind(id)
    .first<{ name_ko: string; verify_status: string }>();
}

// ── 기업 등록·편집 (routes/biz.tsx, routes/biz-company.tsx)

export interface RegisterCompanyInput {
  id: string; name_ko: string; name_zh: string | null; biz_no: string | null; entity_type: string; hq_name: string | null;
  entry_stage: string | null; industry: string | null; website: string | null; ts: number; userId: string; ownerIsHq: number;
}

/**
 * 기업과 대표 담당자(owner)를 한 번에 만든다. 두 번째 문장(담당자 추가)이 1행이면 true.
 * [sqlite] batch = 트랜잭션. is_hq 0/1.
 * [sqlite] INSERT … SELECT ?,?,… WHERE … 를 조건부 추가로 쓴다. PostgreSQL 에서도 되지만, FROM 없는 SELECT 목록의 매개변수는
 *          형이 text 로 정해질 수 있어 숫자 컬럼(created_at, is_hq)에는 `$n::integer` 처럼 형을 적어야 할 수 있다 (확인 필요).
 */
export async function registerCompany(db: D1Database, x: RegisterCompanyInput): Promise<boolean> {
  // 두 문장 모두 "아직 소속이 없을 때만" 실행된다 (동시에 두 번 눌러도 기업이 둘 생기지 않게). batch 는 한 트랜잭션이다.
  const res = await db.batch([
    db.prepare(
      `INSERT INTO companies (id, name_ko, name_zh, biz_no, entity_type, hq_name, entry_stage, industry, website, verify_status, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM company_members WHERE user_id = ?)`,
    ).bind(x.id, x.name_ko, x.name_zh, x.biz_no, x.entity_type, x.hq_name, x.entry_stage, x.industry, x.website, x.ts, x.userId),
    db.prepare(
      `INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at)
       SELECT ?, ?, 'owner', ?, ? WHERE EXISTS (SELECT 1 FROM companies WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM company_members WHERE user_id = ?)`,
    ).bind(x.id, x.userId, x.ownerIsHq, x.ts, x.id, x.userId),
  ]);
  return res[1]?.meta.changes === 1;
}

export interface CompanyEditValues {
  name_ko: string; name_zh: string | null; biz_no: string | null; entity_type: string; hq_name: string | null;
  entry_stage: string | null; industry: string | null; website: string | null; profile_ko: string | null;
}

export interface SaveCompanyEditInput {
  locked: boolean;
  v: CompanyEditValues;
  nextStatus: string;            // 잠기지 않은 경우의 새 검증 상태 (lib/company.planCompanyEdit)
  rejectReason: string | null;   // 잠기지 않은 경우 저장할 반려 사유 (호출부가 정한다)
  id: string;
  readStatus: string;            // 화면을 열 때 읽은 검증 상태
  /** 사업자 형태를 바꿨을 때만: 대표 담당자의 is_hq 값(0/1). 없으면 두 번째 문장을 보내지 않는다. */
  ownerIsHq: number | null;
}

/** 기업 정보 편집. 첫 문장(기업 행)이 1행이면 true. [sqlite] batch = 트랜잭션, is_hq 0/1. */
export async function saveCompanyEdit(db: D1Database, x: SaveCompanyEditInput): Promise<boolean> {
  const v = x.v;
  // 읽은 뒤 상태가 바뀌었으면(예: 그사이 관리자가 승인) 반영하지 않는다 — WHERE verify_status = 읽은 상태.
  const update = x.locked
    // 검증된 기업: 신원 항목은 SQL 에서도 건드리지 않는다.
    ? db.prepare(
        `UPDATE companies SET hq_name = ?, entry_stage = ?, industry = ?, website = ?, profile_ko = ?
         WHERE id = ? AND verify_status = 'verified'`,
      ).bind(v.hq_name, v.entry_stage, v.industry, v.website, v.profile_ko, x.id)
    : db.prepare(
        `UPDATE companies SET name_ko = ?, name_zh = ?, biz_no = ?, entity_type = ?, hq_name = ?, entry_stage = ?,
           industry = ?, website = ?, profile_ko = ?, verify_status = ?, reject_reason = ?
         WHERE id = ? AND verify_status = ?`,
      ).bind(
        v.name_ko, v.name_zh, v.biz_no, v.entity_type, v.hq_name, v.entry_stage, v.industry, v.website, v.profile_ko,
        x.nextStatus, x.rejectReason, x.id, x.readStatus,
      );
  const stmts = [update];
  // 사업자 형태를 바꾸면 대표 담당자의 본사 소속 여부도 등록 때와 같은 규칙으로 맞춘다 (검증 전에만 가능).
  if (x.ownerIsHq !== null) {
    stmts.push(db.prepare(
      `UPDATE company_members SET is_hq = ? WHERE company_id = ? AND member_role = 'owner'
         AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND entity_type = ?)`,
    ).bind(x.ownerIsHq, x.id, x.id, v.entity_type));
  }
  const res = await db.batch(stmts);
  return res[0]?.meta.changes === 1;
}

/** 반려된 기업이 서류를 새로 올리면 다시 검증 대기로 (반려 상태일 때만). */
export async function reopenRejectedCompany(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE companies SET verify_status = 'pending', reject_reason = NULL WHERE id = ? AND verify_status = 'rejected'")
    .bind(id).run();
}

// ── 검증 서류 행 (파일 자체는 R2, lib/files.ts)

export async function listCompanyDocs(db: D1Database, companyId: string): Promise<DocView[]> {
  const r = await db.prepare(
    "SELECT id, doc_type, review_status, created_at FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? ORDER BY created_at DESC",
  ).bind(companyId).all<DocView>();
  return r.results;
}

/** 등록된 기업 서류 종류 (반려된 서류는 승인 조건에 넣지 않는다). */
export async function listActiveCompanyDocTypes(db: D1Database, companyId: string): Promise<string[]> {
  const r = await db.prepare(
    "SELECT doc_type FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? AND review_status != 'rejected'",
  ).bind(companyId).all<{ doc_type: string }>();
  return r.results.map((x) => x.doc_type);
}

export async function insertVerificationDoc(
  db: D1Database, id: string, ownerType: string, ownerId: string, docType: string, r2Key: string, reviewStatus: string, createdAt: number,
): Promise<void> {
  await db.prepare(
    'INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, created_at) VALUES (?,?,?,?,?,?,?)',
  ).bind(id, ownerType, ownerId, docType, r2Key, reviewStatus, createdAt).run();
}

export interface VerificationDocRow { id: string; owner_type: 'company' | 'agency'; owner_id: string; r2_key: string }

export async function findVerificationDoc(db: D1Database, id: string): Promise<VerificationDocRow | null> {
  return db.prepare('SELECT id, owner_type, owner_id, r2_key FROM verification_docs WHERE id = ?')
    .bind(id).first<VerificationDocRow>();
}

// ── 담당자·초대 (routes/biz.tsx, routes/biz-members.tsx)

/** 로그인한 이메일로 받은 수락 대기 초대. */
export async function listPendingInvitesForEmail(db: D1Database, email: string): Promise<InviteView[]> {
  const r = await db.prepare(
    `SELECT i.id, i.is_hq, c.name_ko, c.name_zh FROM company_invites i JOIN companies c ON c.id = i.company_id
     WHERE i.email = ? AND i.accepted_at IS NULL ORDER BY i.created_at`,
  ).bind(email).all<InviteView>();
  return r.results;
}

/**
 * 초대 수락. 첫 문장(담당자 추가)이 1행이면 true.
 * [sqlite] INSERT … SELECT … WHERE 조건부 추가 — registerCompany 주석 참고 (여기는 FROM 이 있어 형 문제는 작다. 확인 필요).
 */
export async function acceptInvite(db: D1Database, x: { userId: string; ts: number; inviteId: string; email: string }): Promise<boolean> {
  const res = await db.batch([
    db.prepare(
      `INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at)
       SELECT i.company_id, ?, 'member', i.is_hq, ? FROM company_invites i
       WHERE i.id = ? AND i.email = ? AND i.accepted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM company_members WHERE user_id = ?)`,
    ).bind(x.userId, x.ts, x.inviteId, x.email, x.userId),
    db.prepare(
      `UPDATE company_invites SET accepted_at = ?
       WHERE id = ? AND email = ? AND accepted_at IS NULL
         AND EXISTS (SELECT 1 FROM company_members m WHERE m.user_id = ? AND m.company_id = company_invites.company_id)`,
    ).bind(x.ts, x.inviteId, x.email, x.userId),
  ]);
  return res[0]?.meta.changes === 1;
}

/** 담당자 목록과 수락 대기 초대. [sqlite] 읽기 두 개를 batch 로 보낸다 — PostgreSQL 에서는 두 번 조회하거나 한 트랜잭션으로. */
export async function listMembersAndInvites(db: D1Database, companyId: string): Promise<{ members: MemberView[]; invites: PendingInviteView[] }> {
  const [m, i] = await db.batch([
    db.prepare(
      `SELECT m.user_id, u.email, m.member_role, m.is_hq, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.member_role = 'owner' DESC, m.created_at`,
    ).bind(companyId),
    db.prepare('SELECT id, email, is_hq, created_at FROM company_invites WHERE company_id = ? AND accepted_at IS NULL ORDER BY created_at')
      .bind(companyId),
  ]);
  return { members: (m?.results ?? []) as MemberView[], invites: (i?.results ?? []) as PendingInviteView[] };
}

/** 이 주소가 이미 담당자인지, 이미 초대했는지. [sqlite] 읽기 batch — listMembersAndInvites 주석 참고. */
export async function inviteConflicts(db: D1Database, companyId: string, email: string): Promise<{ alreadyMember: boolean; duplicate: boolean }> {
  const [already, dup] = await db.batch([
    db.prepare('SELECT 1 AS x FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND u.email = ?').bind(companyId, email),
    db.prepare('SELECT 1 AS x FROM company_invites WHERE company_id = ? AND email = ?').bind(companyId, email),
  ]);
  return { alreadyMember: !!already?.results.length, duplicate: !!dup?.results.length };
}

/**
 * 한도 안일 때만 초대를 추가하고 영향 행 수(0 또는 1)를 돌려준다.
 * (company_id, email) 중복이면 예외를 그대로 던진다 — 호출부가 잡아서 "중복" 으로 안내한다.
 * [sqlite] INSERT … SELECT ?,… WHERE (COUNT…) < ? — FROM 없는 SELECT 목록의 매개변수 형(is_hq, created_at): registerCompany 주석 참고.
 * [sqlite] 중복 시 예외의 종류·메시지가 PostgreSQL 에서는 다르다(SQLSTATE 23505). 지금 호출부는 종류를 보지 않고 모두 "중복" 으로 본다.
 */
export async function insertInviteWithinLimit(
  db: D1Database,
  x: { id: string; companyId: string; email: string; isHq: number; invitedBy: string; ts: number; maxSeats: number },
): Promise<number> {
  // 한도 검사와 추가를 한 문장으로 (동시에 여러 번 눌러도 한도를 넘지 않게).
  const r = await db.prepare(
    `INSERT INTO company_invites (id, company_id, email, is_hq, invited_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM company_members WHERE company_id = ?)
           + (SELECT COUNT(*) FROM company_invites WHERE company_id = ? AND accepted_at IS NULL) < ?`,
  ).bind(
    x.id, x.companyId, x.email, x.isHq, x.invitedBy, x.ts,
    x.companyId, x.companyId, x.maxSeats,
  ).run();
  return r.meta.changes;
}

export async function findCompanyMember(db: D1Database, companyId: string, userId: string): Promise<{ user_id: string; member_role: 'owner' | 'member' } | null> {
  return db.prepare('SELECT user_id, member_role FROM company_members WHERE company_id = ? AND user_id = ?')
    .bind(companyId, userId).first<{ user_id: string; member_role: 'owner' | 'member' }>();
}

/** 담당자 내보내기(대표 담당자는 지우지 않는다). 같은 사람을 다시 초대할 수 있도록 그 사람의 (수락된) 초대 기록도 지운다. [sqlite] batch = 트랜잭션. */
export async function removeMember(db: D1Database, companyId: string, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM company_members WHERE company_id = ? AND user_id = ? AND member_role = 'member'").bind(companyId, userId),
    db.prepare('DELETE FROM company_invites WHERE company_id = ? AND email = (SELECT email FROM users WHERE id = ?)').bind(companyId, userId),
  ]);
}

/** 수락 전 초대 취소. 1행이 지워졌으면 true. */
export async function cancelInvite(db: D1Database, inviteId: string, companyId: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM company_invites WHERE id = ? AND company_id = ? AND accepted_at IS NULL')
    .bind(inviteId, companyId).run();
  return r.meta.changes === 1;
}

// ── 공개 기업 화면 (routes/companies.tsx). 검증된 기업만.

/** [sqlite] ORDER BY name_ko 는 SQLite 기본 BINARY(바이트) 순서다. PostgreSQL 은 DB 콜레이션을 따르므로 한글 정렬 순서가 달라질 수 있다 (COLLATE "C" 로 맞출 수 있음). */
export async function listPublicCompanies(db: D1Database): Promise<PublicCompanyRow[]> {
  const r = await db.prepare(
    "SELECT id, name_ko, name_zh, industry, entry_stage FROM companies WHERE verify_status = 'verified' ORDER BY name_ko LIMIT 500",
  ).all<PublicCompanyRow>();
  return r.results;
}

export async function findPublicCompany(db: D1Database, id: string): Promise<PublicCompanyView | null> {
  return db.prepare(
    `SELECT name_ko, name_zh, hq_name, entry_stage, industry, website, profile_ko
     FROM companies WHERE id = ? AND verify_status = 'verified'`,
  ).bind(id).first<PublicCompanyView>();
}

// ── 관리자 기업 검증 (routes/admin.tsx)

/** [sqlite] COUNT(*) 는 SQLite 에서 숫자로 온다. PostgreSQL(node-postgres 등)에서는 bigint 라 문자열로 올 수 있다 — `::int` 로 바꾸거나 변환한다 (확인 필요). */
export async function listCompaniesForAdmin(db: D1Database): Promise<AdminCompanyListRow[]> {
  const r = await db.prepare(
    `SELECT c.id, c.name_ko, c.entity_type, c.verify_status, c.created_at,
            (SELECT COUNT(*) FROM verification_docs d WHERE d.owner_type = 'company' AND d.owner_id = c.id) AS docs
     FROM companies c
     ORDER BY CASE c.verify_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, c.created_at DESC
     LIMIT 500`,
  ).all<AdminCompanyListRow>();
  return r.results;
}

export interface CompanyDetail { company: CompanyRow; members: MemberView[]; docs: DocView[] }

/** 기업 행·담당자·서류. [sqlite] 읽기 세 개를 batch 로 — listMembersAndInvites 주석 참고. */
export async function loadCompanyDetail(db: D1Database, id: string): Promise<CompanyDetail | null> {
  const [co, m, d] = await db.batch([
    db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE id = ?`).bind(id),
    db.prepare(
      `SELECT m.user_id, u.email, m.member_role, m.is_hq, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.member_role = 'owner' DESC, m.created_at`,
    ).bind(id),
    db.prepare("SELECT id, doc_type, review_status, created_at FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? ORDER BY created_at DESC")
      .bind(id),
  ]);
  const company = co?.results[0] as CompanyRow | undefined;
  if (!company) return null;
  return { company, members: (m?.results ?? []) as MemberView[], docs: (d?.results ?? []) as DocView[] };
}

/**
 * "서류에 문제가 있음" 을 체크했을 때: 그 기업의 아직 반려되지 않은 서류(확인 대기·확인 완료)를 반려한다.
 * 반려된 서류는 verifyBlocks 에 넣지 않으므로, 기업이 새 서류를 올려야 다시 승인할 수 있다.
 * 기업 상태가 whenStatus 일 때만 실행된다 — batch 에서 기업 상태를 바꾸는 문장보다 먼저 둔다 (한 트랜잭션이라 둘 다 되거나 둘 다 안 된다).
 */
function rejectDocsStmt(db: D1Database, companyId: string, adminId: string, ts: number, whenStatus: 'pending' | 'verified') {
  return db.prepare(
    `UPDATE verification_docs SET review_status = 'rejected', reviewed_by = ?, reviewed_at = ?
     WHERE owner_type = 'company' AND owner_id = ? AND review_status IN ('pending','approved')
       AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND verify_status = ?)`,
  ).bind(adminId, ts, companyId, companyId, whenStatus);
}

/** 반려 (검증 대기일 때만). 마지막 문장(기업 반려)이 1행이면 true. [sqlite] batch = 트랜잭션 — 순서 그대로 BEGIN … COMMIT. */
export async function rejectCompany(
  db: D1Database, x: { id: string; reason: string; rejectDocs: boolean; adminId: string; ts: number },
): Promise<boolean> {
  // 서류 반려(선택)를 먼저, 기업 반려를 마지막에 둔다. 둘 다 "검증 대기일 때만" 이라 함께 되거나 함께 안 된다.
  const stmts = x.rejectDocs ? [rejectDocsStmt(db, x.id, x.adminId, x.ts, 'pending')] : [];
  stmts.push(
    db.prepare("UPDATE companies SET verify_status = 'rejected', reject_reason = ? WHERE id = ? AND verify_status = 'pending'")
      .bind(x.reason, x.id),
  );
  const res = await db.batch(stmts);
  return res[res.length - 1]?.meta.changes === 1;
}

/** 승인 (검증 대기일 때만). 첫 문장(기업 승인)이 1행이면 true. 서류 승인은 같은 ts 로 승인된 경우에만 따라간다. [sqlite] batch = 트랜잭션. */
export async function approveCompany(db: D1Database, x: { id: string; adminId: string; ts: number }): Promise<boolean> {
  const res = await db.batch([
    db.prepare(
      "UPDATE companies SET verify_status = 'verified', verified_at = ?, reject_reason = NULL WHERE id = ? AND verify_status = 'pending'",
    ).bind(x.ts, x.id),
    db.prepare(
      `UPDATE verification_docs SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?
       WHERE owner_type = 'company' AND owner_id = ? AND review_status = 'pending'
         AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND verify_status = 'verified' AND verified_at = ?)`,
    ).bind(x.adminId, x.ts, x.id, x.id, x.ts),
  ]);
  return res[0]?.meta.changes === 1;
}

/** 승인 취소 (검증 완료일 때만). 게재 중 공고 마감 → (선택) 서류 반려 → 기업 반려. 마지막 문장이 1행이면 true. [sqlite] batch = 트랜잭션 — 순서 그대로 BEGIN … COMMIT. */
export async function revokeCompany(
  db: D1Database, x: { id: string; reason: string; rejectDocs: boolean; adminId: string; ts: number },
): Promise<boolean> {
  // 공고 마감·서류 반려를 먼저, 기업 상태 변경을 마지막에 둔다. 모두 "지금 검증 완료일 때만" 이라 한 트랜잭션 안에서
  // 함께 되거나 함께 안 된다 (마지막 문장의 결과로 판단한다).
  const stmts = [
    db.prepare(
      `UPDATE jobs SET status = 'closed', updated_at = ? WHERE company_id = ? AND status = 'published'
         AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND verify_status = 'verified')`,
    ).bind(x.ts, x.id, x.id),
  ];
  if (x.rejectDocs) stmts.push(rejectDocsStmt(db, x.id, x.adminId, x.ts, 'verified'));
  stmts.push(
    db.prepare("UPDATE companies SET verify_status = 'rejected', reject_reason = ?, verified_at = NULL WHERE id = ? AND verify_status = 'verified'")
      .bind(x.reason, x.id),
  );
  const res = await db.batch(stmts);
  return res[res.length - 1]?.meta.changes === 1;
}
