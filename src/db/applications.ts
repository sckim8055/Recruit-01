// 지원 (applications, application_events, consents 의 cross_border). 값의 뜻·검사·암호화는 호출부(lib/application.ts)가 한다.
// resume_snapshot 에는 암호문만 넘어온다. 구직자 쪽 문장은 모두 seeker_id 를 조건에 넣는다.
//
// [sqlite] batch = 한 트랜잭션, changes = rowCount. INSERT … SELECT … WHERE 로 조건부 추가.
// [sqlite] UNIQUE (job_id, seeker_id) 위반은 예외로 온다 — insertApplication 이 false 로 바꾼다 (PostgreSQL 은 SQLSTATE 23505).
import { publicJobWhere } from './public-jobs';
import type { Flags } from '../env';

export interface ApplicationRow {
  id: string;
  job_id: string;
  seeker_id: string;
  resume_id: string | null;
  resume_snapshot: string;      // 🔒 암호문. 취소하면 '' (내용 삭제)
  file_r2_key: string | null;
  cross_border_consent_at: number | null;
  status: string;
  status_changed_at: number;
  created_at: number;
}

export interface OwnApplicationListRow {
  id: string;
  job_id: string;
  status: string;
  status_changed_at: number;
  created_at: number;
  title_ko: string | null;
  company_name: string | null;  // 기업명 비공개 공고면 NULL
}

export async function hasApplied(db: D1Database, jobId: string, seekerId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM applications WHERE job_id = ? AND seeker_id = ?').bind(jobId, seekerId).first()) !== null;
}

/** 그 기업의 담당자 수: 중국 본사 소속 / 그 밖. 국외 이전 동의가 필요한지 정하는 데 쓴다 (lib/application.consentNeed). */
export async function memberCounts(db: D1Database, companyId: string): Promise<{ hqMembers: number; localMembers: number }> {
  const r = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN is_hq = 1 THEN 1 ELSE 0 END), 0) AS hq, COALESCE(SUM(CASE WHEN is_hq = 1 THEN 0 ELSE 1 END), 0) AS local
     FROM company_members WHERE company_id = ?`,
  ).bind(companyId).first<{ hq: number; local: number }>();
  return { hqMembers: Number(r?.hq ?? 0), localMembers: Number(r?.local ?? 0) };
}

/** 새 지원자 알림을 받을 기업 담당자 주소. 메일에는 개인정보를 넣지 않는다 (lib/application.newApplicantMail). */
export async function companyMemberEmails(db: D1Database, companyId: string): Promise<string[]> {
  const r = await db.prepare(
    `SELECT u.email FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND u.status = 'active'`,
  ).bind(companyId).all<{ email: string }>();
  return r.results.map((x) => x.email);
}

/**
 * 지원서 저장. 한 문장 안에서 다시 확인한다: 공고가 지금도 공개 조건을 만족하고(공개 조건은 publicJobWhere 하나),
 * 같은 공고에 지원한 적이 없을 때만 들어간다. 국외 이전 동의가 있으면 같은 트랜잭션에서 consents 에 남긴다.
 * 들어갔으면 true. 공고가 그사이 내려갔거나 이미 지원했으면 false.
 */
export async function insertApplication(
  db: D1Database,
  a: { id: string; jobId: string; seekerId: string; resumeId: string; snapshot: string; fileKey: string | null; consentAt: number | null; consentVersion: string; ts: number },
  flags: Flags,
): Promise<boolean> {
  const vis = publicJobWhere(flags, a.ts);
  const stmts = [
    db.prepare(
      `INSERT INTO applications (id, job_id, seeker_id, resume_id, resume_snapshot, file_r2_key, cross_border_consent_at, status, status_changed_at, created_at)
       SELECT ?, j.id, ?, ?, ?, ?, ?, 'submitted', ?, ?
       FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.id = ? AND ${vis.sql}
         AND NOT EXISTS (SELECT 1 FROM applications WHERE job_id = j.id AND seeker_id = ?)`,
    ).bind(a.id, a.seekerId, a.resumeId, a.snapshot, a.fileKey, a.consentAt, a.ts, a.ts, a.jobId, ...vis.binds, a.seekerId),
  ];
  if (a.consentAt !== null) {
    stmts.push(
      db.prepare(
        `INSERT INTO consents (id, user_id, type, version, ref_id, agreed_at)
         SELECT ?, ?, 'cross_border', ?, ?, ? WHERE EXISTS (SELECT 1 FROM applications WHERE id = ? AND seeker_id = ?)`,
      ).bind(crypto.randomUUID(), a.seekerId, a.consentVersion, a.id, a.consentAt, a.id, a.seekerId),
    );
  }
  try {
    const res = await db.batch(stmts);
    return res[0]?.meta.changes === 1;
  } catch {
    return false; // 같은 순간에 두 번 누른 경우 (UNIQUE 위반)
  }
}

/** 내 지원 한 건 (남의 것·없는 것은 null). */
export async function getOwnApplication(db: D1Database, id: string, seekerId: string): Promise<ApplicationRow | null> {
  return db.prepare(
    `SELECT id, job_id, seeker_id, resume_id, resume_snapshot, file_r2_key, cross_border_consent_at, status, status_changed_at, created_at
     FROM applications WHERE id = ? AND seeker_id = ?`,
  ).bind(id, seekerId).first<ApplicationRow>();
}

/** 내 지원 현황 (최근 순). 공고가 마감·차단되어 공개 목록에서 빠져도 내 지원 기록에는 제목이 남는다. */
export async function listOwnApplications(db: D1Database, seekerId: string): Promise<OwnApplicationListRow[]> {
  const r = await db.prepare(
    `SELECT a.id, a.job_id, a.status, a.status_changed_at, a.created_at, j.title_ko,
            CASE WHEN j.company_name_public = 1 THEN c.name_ko END AS company_name
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
     WHERE a.seeker_id = ? ORDER BY a.created_at DESC, a.id LIMIT 200`,
  ).bind(seekerId).all<OwnApplicationListRow>();
  return r.results;
}

/**
 * 지원 취소. 이벤트를 남기고(규칙 3), 상태를 newStatus(호출부가 rules.nextStatus 로 계산한 값)로 바꾸며,
 * 지원서 내용과 파일 키를 지우고, 국외 이전 동의도 철회로 표시한다 — 모두 한 트랜잭션.
 * fromStatuses(취소할 수 있는 상태) 일 때만 실행된다. 바뀌었으면 true. R2 파일은 호출부가 지운다.
 */
export async function withdrawApplication(
  db: D1Database, w: { id: string; seekerId: string; newStatus: string; fromStatuses: string[]; ts: number },
): Promise<boolean> {
  const marks = w.fromStatuses.map(() => '?').join(',');
  const res = await db.batch([
    db.prepare(
      `INSERT INTO application_events (id, application_id, event, actor_id, at)
       SELECT ?, id, 'withdrawn', ?, ? FROM applications WHERE id = ? AND seeker_id = ? AND status IN (${marks})`,
    ).bind(crypto.randomUUID(), w.seekerId, w.ts, w.id, w.seekerId, ...w.fromStatuses),
    db.prepare(
      `UPDATE applications SET status = ?, status_changed_at = ?, resume_snapshot = '', file_r2_key = NULL, summary_zh = NULL, purge_after = ?
       WHERE id = ? AND seeker_id = ? AND status IN (${marks})`,
    ).bind(w.newStatus, w.ts, w.ts, w.id, w.seekerId, ...w.fromStatuses),
    db.prepare(
      `UPDATE consents SET withdrawn_at = ? WHERE type = 'cross_border' AND ref_id = ? AND user_id = ? AND withdrawn_at IS NULL
         AND EXISTS (SELECT 1 FROM applications WHERE id = ? AND seeker_id = ? AND status = ?)`,
    ).bind(w.ts, w.id, w.seekerId, w.id, w.seekerId, w.newStatus),
  ]);
  return res[1]?.meta.changes === 1;
}

/** 회원 탈퇴(T-11)·정리 작업용: 그 회원의 지원서 파일 키 목록. */
export async function listApplicationFileKeys(db: D1Database, seekerId: string): Promise<string[]> {
  const r = await db.prepare('SELECT file_r2_key FROM applications WHERE seeker_id = ? AND file_r2_key IS NOT NULL').bind(seekerId).all<{ file_r2_key: string }>();
  return r.results.map((x) => x.file_r2_key);
}
