// 조건 알림 (T-10, migrations 0012). 판단은 lib/alerts.ts · lib/alert-send.ts — 여기서는 받은 값으로 SQL 만 실행한다.
// - 구직자 쪽 문장은 모두 seeker_id 조건을 가진다 (남의 알림은 없는 것과 같다).
// - 해지 토큰은 해시(token_hash)로만 찾는다. 토큰 원문은 DB 에 없다.
// - 공고 읽기는 공개 조건 publicJobWhere + 검색 조건 filterWhere (db/public-jobs.ts) 를 그대로 쓴다 — /jobs 에 보이는 공고만 나온다.
//   공개 컬럼만 고르고, 기업명 비공개 공고는 기업 이름을 SQL 에서부터 NULL 로 받는다. 순서는 게재 최신 순뿐이다.
//
// [sqlite] meta.changes, batch = 한 트랜잭션. `COUNT(*) OVER ()` (창 함수, SQLite 3.25+ — PostgreSQL 도 같다).
// [sqlite] 행 수 한도는 `id IN (SELECT id … LIMIT ?)` 로 건다 (SQLite 기본 빌드는 DELETE … LIMIT 이 없다).
import type { Flags } from '../env';
import type { JobFilter } from '../lib/public-jobs';
import { filterWhere, publicJobWhere } from './public-jobs';
import type { Db } from './types';

export interface AlertRow {
  id: string;
  filter_json: string;
  frequency: 'daily' | 'weekly';
  status: 'active' | 'paused';
  paused_reason: 'user' | 'unsubscribe' | 'failures' | null;
  next_due_at: number;
  last_sent_at: number | null;
  created_at: number;
}

const ROW_COLS = 'id, filter_json, frequency, status, paused_reason, next_due_at, last_sent_at, created_at';

/** 내 알림 (만든 순서). 5개 한도라 LIMIT 은 여유로 둔다. */
export async function listMyAlerts(db: Db, seekerId: string): Promise<AlertRow[]> {
  return (await db.prepare(`SELECT ${ROW_COLS} FROM alerts WHERE seeker_id = ? ORDER BY created_at, id LIMIT 20`).bind(seekerId).all<AlertRow>()).results;
}

export type InsertAlertResult = 'ok' | 'limit' | 'duplicate';

/**
 * 한 문장으로: 내 알림이 max 개 미만이고 같은 조건(filter_json 글자 그대로)의 알림이 없을 때만 넣는다.
 * 거절되면 어느 쪽인지 한 번 더 읽어 알려 준다.
 */
export async function insertAlert(db: Db, x: {
  id: string; seekerId: string; filterJson: string; frequency: string; now: number; nextDue: number; optinVersion: string; max: number;
}): Promise<InsertAlertResult> {
  const res = await db.prepare(
    `INSERT INTO alerts (id, seeker_id, filter_json, frequency, last_sent_at, created_at, status, paused_reason, next_due_at, checked_until,
                         fail_count, optin_at, optin_version, updated_at)
     SELECT ?, ?, ?, ?, NULL, ?, 'active', NULL, ?, ?, 0, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM alerts WHERE seeker_id = ?) < ?
       AND NOT EXISTS (SELECT 1 FROM alerts WHERE seeker_id = ? AND filter_json = ?)`,
  ).bind(x.id, x.seekerId, x.filterJson, x.frequency, x.now, x.nextDue, x.now, x.now, x.optinVersion, x.now, x.seekerId, x.max, x.seekerId, x.filterJson).run();
  if (res.meta.changes === 1) return 'ok';
  const dup = await db.prepare('SELECT 1 AS x FROM alerts WHERE seeker_id = ? AND filter_json = ? LIMIT 1').bind(x.seekerId, x.filterJson).first();
  return dup ? 'duplicate' : 'limit';
}

/** 빈도 바꾸기 (다음 차례도 새 빈도로). */
export async function setMyAlertFrequency(db: Db, x: { id: string; seekerId: string; frequency: string; nextDue: number; now: number }): Promise<boolean> {
  const res = await db.prepare('UPDATE alerts SET frequency = ?, next_due_at = ?, updated_at = ? WHERE id = ? AND seeker_id = ?')
    .bind(x.frequency, x.nextDue, x.now, x.id, x.seekerId).run();
  return res.meta.changes === 1;
}

/** 본인이 멈추기. 이미 멈춘 알림은 이유를 바꾸지 않는다. */
export async function pauseMyAlert(db: Db, x: { id: string; seekerId: string; now: number }): Promise<boolean> {
  const res = await db.prepare("UPDATE alerts SET status = 'paused', paused_reason = 'user', updated_at = ? WHERE id = ? AND seeker_id = ? AND status = 'active'")
    .bind(x.now, x.id, x.seekerId).run();
  return res.meta.changes === 1;
}

/**
 * 다시 켜기: 실패 수를 0 으로, 확인 기준을 지금으로 (멈춰 있던 동안 게재된 공고를 한꺼번에 보내지 않는다), 다음 차례를 새로 정한다.
 * 메일 수신 동의를 다시 받으므로 동의 시각·판도 바꾼다 (화면의 체크 칸).
 */
export async function resumeMyAlert(db: Db, x: { id: string; seekerId: string; now: number; nextDue: number; optinVersion: string }): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE alerts SET status = 'active', paused_reason = NULL, fail_count = 0, checked_until = ?, next_due_at = ?, optin_at = ?, optin_version = ?, updated_at = ?
     WHERE id = ? AND seeker_id = ? AND status = 'paused'`,
  ).bind(x.now, x.nextDue, x.now, x.optinVersion, x.now, x.id, x.seekerId).run();
  return res.meta.changes === 1;
}

/** 지우기 (해지 토큰은 ON DELETE CASCADE 로 같이 지워진다). */
export async function deleteMyAlert(db: Db, x: { id: string; seekerId: string }): Promise<boolean> {
  const res = await db.prepare('DELETE FROM alerts WHERE id = ? AND seeker_id = ?').bind(x.id, x.seekerId).run();
  return res.meta.changes === 1;
}

// ── 해지 링크 (토큰 해시로만)

export interface TokenAlertRow { id: string; seeker_id: string; filter_json: string; frequency: 'daily' | 'weekly'; status: 'active' | 'paused' }

/** 토큰 해시 → 그 알림. 없거나(모르는 토큰·만료·지운 알림) 탈퇴한 계정이면 null. */
export async function findAlertByToken(db: Db, tokenHash: string): Promise<TokenAlertRow | null> {
  return db.prepare(
    `SELECT a.id, a.seeker_id, a.filter_json, a.frequency, a.status FROM alert_unsub_tokens t JOIN alerts a ON a.id = t.alert_id
     JOIN users u ON u.id = a.seeker_id WHERE t.token_hash = ? AND u.status != 'deleted'`,
  ).bind(tokenHash).first<TokenAlertRow>();
}

/** 해지 링크로 그 알림 하나를 멈춘다. 이미 멈췄으면 아무것도 바꾸지 않는다(이유도 그대로). 토큰이 가리키는 알림이 있으면 true. */
export async function pauseAlertByToken(db: Db, x: { tokenHash: string; now: number }): Promise<boolean> {
  const [, found] = await db.batch([
    db.prepare(
      `UPDATE alerts SET status = 'paused', paused_reason = 'unsubscribe', updated_at = ?
       WHERE status = 'active' AND id = (SELECT alert_id FROM alert_unsub_tokens WHERE token_hash = ?)`,
    ).bind(x.now, x.tokenHash),
    db.prepare('SELECT 1 AS x FROM alert_unsub_tokens WHERE token_hash = ?').bind(x.tokenHash),
  ]);
  return ((found?.results ?? []) as unknown[]).length > 0;
}

/** 해지 링크로 그 사람의 모든 알림을 멈춘다. 멈춘 수. */
export async function pauseAllByToken(db: Db, x: { tokenHash: string; now: number }): Promise<number> {
  const res = await db.prepare(
    `UPDATE alerts SET status = 'paused', paused_reason = 'unsubscribe', updated_at = ?
     WHERE status = 'active'
       AND seeker_id = (SELECT a.seeker_id FROM alert_unsub_tokens t JOIN alerts a ON a.id = t.alert_id WHERE t.token_hash = ?)`,
  ).bind(x.now, x.tokenHash).run();
  return res.meta.changes;
}

// ── 예약 작업 (lib/alert-send.ts)

export interface DueAlertRow {
  id: string;
  seeker_id: string;
  email: string;
  locale: 'ko' | 'zh';
  filter_json: string;
  frequency: 'daily' | 'weekly';
  checked_until: number;
  fail_count: number;
}

/**
 * 보낼 차례가 된 알림, 오래된 차례부터 limit 개. 대상: 켜진 알림 + 수신 동의가 있음 + 계정이 활동 중인 구직자
 * + 지금 판의 이용약관·개인정보 동의가 있음(철회 안 됨). 정지·탈퇴·동의 전 회원의 알림은 읽지 않는다(차례도 그대로 둔다).
 */
export async function listDueAlerts(db: Db, x: { now: number; termsVersion: string; privacyVersion: string; limit: number }): Promise<DueAlertRow[]> {
  return (await db.prepare(
    `SELECT a.id, a.seeker_id, u.email, u.locale, a.filter_json, a.frequency, a.checked_until, a.fail_count
     FROM alerts a JOIN users u ON u.id = a.seeker_id
     WHERE a.status = 'active' AND a.next_due_at > 0 AND a.next_due_at <= ? AND a.optin_at > 0
       AND u.status = 'active' AND u.role = 'seeker'
       AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.type = 'terms' AND c.version = ? AND c.withdrawn_at IS NULL)
       AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.type = 'privacy' AND c.version = ? AND c.withdrawn_at IS NULL)
     ORDER BY a.next_due_at, a.id LIMIT ?`,
  ).bind(x.now, x.termsVersion, x.privacyVersion, x.limit).all<DueAlertRow>()).results;
}

export interface AlertJobRow {
  id: string;
  title_ko: string | null;
  company_name: string | null; // 기업명 비공개면 NULL
  location: string | null;
  closes_at: number | null;
  published_at: number;
  total: number;               // 이 조건·기간에 맞는 전체 수 (LIMIT 전)
}

/** 한 알림의 새 공고 SQL: 공개 조건 + 검색 조건 + (since, until] 에 게재. 최신 게재 순(/jobs 와 같은 순서)만. */
export function alertJobsSql(flags: Flags, now: number, f: JobFilter, since: number, until: number, limit: number): { sql: string; binds: unknown[] } {
  const v = publicJobWhere(flags, now);
  const w = filterWhere(f);
  return {
    sql: `SELECT j.id, j.title_ko, CASE WHEN j.company_name_public = 1 THEN c.name_ko END AS company_name, j.location, j.closes_at, j.published_at,
                 COUNT(*) OVER () AS total
          FROM jobs j JOIN companies c ON c.id = j.company_id
          WHERE ${v.sql}${w.sql} AND j.published_at > ? AND j.published_at <= ?
          ORDER BY j.published_at DESC, j.id DESC LIMIT ?`,
    binds: [...v.binds, ...w.binds, since, until, limit],
  };
}

/** 여러 알림의 새 공고를 한 번에 (읽기 batch — 왕복 한 번). 결과는 넘긴 순서대로. */
export async function listNewJobsForAlerts(
  db: Db, x: { flags: Flags; now: number; limit: number; items: Array<{ filter: JobFilter; since: number; until: number }> },
): Promise<AlertJobRow[][]> {
  if (!x.items.length) return [];
  const res = await db.batch(x.items.map((it) => {
    const q = alertJobsSql(x.flags, x.now, it.filter, it.since, it.until, x.limit);
    return db.prepare(q.sql).bind(...q.binds);
  }));
  return res.map((r) => ((r?.results ?? []) as AlertJobRow[]).map((row) => ({ ...row, total: Number(row.total) })));
}

/**
 * 메일을 보낸 **뒤에** 기록한다 (한 batch): 이 메일의 해지 토큰 해시 + 알림의 확인 기준·다음 차례·보낸 시각, 실패 수 0.
 * 토큰은 알림이 아직 있을 때만 넣는다(그사이 지워졌으면 넣지 않는다 — 외래키). 알림 갱신은 아직 켜져 있을 때만.
 */
export async function recordAlertSent(db: Db, x: { id: string; tokenHash: string; now: number; until: number; nextDue: number }): Promise<boolean> {
  const res = await db.batch([
    db.prepare('INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM alerts WHERE id = ?)')
      .bind(x.tokenHash, x.id, x.now, x.id),
    db.prepare("UPDATE alerts SET checked_until = ?, next_due_at = ?, last_sent_at = ?, fail_count = 0 WHERE id = ? AND status = 'active'")
      .bind(x.until, x.nextDue, x.now, x.id),
  ]);
  return res[1]?.meta.changes === 1;
}

/**
 * 메일 없이 차례만 넘긴다 (한 batch): 새 공고가 없음(until 이 있으면 확인 기준도 옮김) 또는 적용되는 조건이 없음(until = null, 확인 기준 그대로).
 */
export async function recordAlertsSkipped(db: Db, items: Array<{ id: string; until: number | null; nextDue: number }>): Promise<number> {
  if (!items.length) return 0;
  const res = await db.batch(items.map((it) => (it.until === null
    ? db.prepare("UPDATE alerts SET next_due_at = ? WHERE id = ? AND status = 'active'").bind(it.nextDue, it.id)
    : db.prepare("UPDATE alerts SET checked_until = ?, next_due_at = ? WHERE id = ? AND status = 'active'").bind(it.until, it.nextDue, it.id))));
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** 보내지 못함: 차례·확인 기준은 그대로(다음 실행에 다시), 실패 수 + 1, max 번째면 멈춤. 멈췄으면 true. */
export async function recordAlertFailure(db: Db, x: { id: string; now: number; max: number }): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE alerts SET fail_count = fail_count + 1,
       status = CASE WHEN fail_count + 1 >= ? THEN 'paused' ELSE status END,
       paused_reason = CASE WHEN fail_count + 1 >= ? THEN 'failures' ELSE paused_reason END,
       updated_at = CASE WHEN fail_count + 1 >= ? THEN ? ELSE updated_at END
     WHERE id = ? AND status = 'active'
     RETURNING status`,
  ).bind(x.max, x.max, x.max, x.now, x.id).first<{ status: string }>();
  return r?.status === 'paused';
}

/**
 * 정리 (한 batch, 각 limit 행). 지우는 것:
 * 1) 탈퇴한 계정(users.status = 'deleted')의 알림 — 탈퇴 트랜잭션(db/account.eraseUser)이 이미 지우지만 남은 것이 있으면.
 * 2) 12개월 동안 쓰지 않은 알림: 본인이 그동안 바꾸지 않았고(updated_at) 그동안 메일이 나가지 않았거나(마지막 메일·만든 시각) 멈춰 있는 것.
 * 3) 180일 지난 해지 토큰 (그보다 오래된 메일의 링크는 "만료" 안내).
 * 알림을 지우면 그 알림의 토큰은 ON DELETE CASCADE 로 함께 지워진다.
 */
export async function sweepAlerts(db: Db, x: { unusedBefore: number; tokenBefore: number; limit: number }): Promise<{ deleted_users: number; unused: number; tokens: number }> {
  const [a, b, c] = await db.batch([
    db.prepare(
      `DELETE FROM alerts WHERE id IN (
         SELECT a.id FROM alerts a JOIN users u ON u.id = a.seeker_id WHERE u.status = 'deleted' LIMIT ?)`,
    ).bind(x.limit),
    db.prepare(
      `DELETE FROM alerts WHERE id IN (
         SELECT id FROM alerts WHERE updated_at < ? AND (status = 'paused' OR COALESCE(last_sent_at, created_at) < ?) LIMIT ?)`,
    ).bind(x.unusedBefore, x.unusedBefore, x.limit),
    db.prepare('DELETE FROM alert_unsub_tokens WHERE token_hash IN (SELECT token_hash FROM alert_unsub_tokens WHERE created_at < ? LIMIT ?)')
      .bind(x.tokenBefore, x.limit),
  ]);
  return { deleted_users: a?.meta.changes ?? 0, unused: b?.meta.changes ?? 0, tokens: c?.meta.changes ?? 0 };
}

/** 관리자 화면: 켜진·멈춘 알림 수 (개수만 — 누구의 어떤 조건인지는 읽지 않는다). */
export async function countAlertsByStatus(db: Db): Promise<{ active: number; paused: number }> {
  const rows = (await db.prepare('SELECT status AS k, COUNT(*) AS n FROM alerts GROUP BY status').all<{ k: string; n: number }>()).results;
  const get = (k: string) => Number(rows.find((r) => r.k === k)?.n ?? 0);
  return { active: get('active'), paused: get('paused') };
}
