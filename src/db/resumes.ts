// 이력서 원본 (resumes, 0002). 값의 뜻·검사·암호화는 호출부(lib/resume.ts)가 한다 — body 에는 암호문만 넘어온다.
// 모든 문장은 user_id 를 조건에 넣는다: 다른 사람의 이력서 id 를 알아도 읽거나 바꿀 수 없다.
//
// [sqlite] is_default 는 INTEGER 0/1. 대표 이력서가 회원당 하나라는 것은 부분 고유 색인(idx_resumes_default … WHERE is_default = 1)이 지킨다.
//          PostgreSQL 도 부분 고유 색인을 지원한다. boolean 으로 바꾸면 아래 `= 1` / `= 0` 비교를 고친다.
// [sqlite] batch = 한 트랜잭션. changes = rowCount.
import type { Db } from './types';

export interface ResumeRow {
  id: string;
  user_id: string;
  title: string;
  /** 작성 언어 'ko' | 'zh' (0002_resume_lang, T-22). 평문 — 개인정보가 아니다. */
  lang: string;
  is_default: number;
  body: string;                 // 🔒 암호문
  file_r2_key: string | null;
  created_at: number;
  updated_at: number;
}

const COLS = 'id, user_id, title, lang, is_default, body, file_r2_key, created_at, updated_at';

/** 내 이력서 목록: 대표 이력서가 맨 위, 그다음 최근 수정 순. */
export async function listResumes(db: Db, userId: string): Promise<ResumeRow[]> {
  const r = await db.prepare(`SELECT ${COLS} FROM resumes WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC, id`).bind(userId).all<ResumeRow>();
  return r.results;
}

export async function getResume(db: Db, id: string, userId: string): Promise<ResumeRow | null> {
  return db.prepare(`SELECT ${COLS} FROM resumes WHERE id = ? AND user_id = ?`).bind(id, userId).first<ResumeRow>();
}

export async function countResumes(db: Db, userId: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM resumes WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * 새 이력서. 한도 검사와 추가를 한 문장으로 한다 (동시에 여러 번 눌러도 한도를 넘지 않게).
 * 그 회원의 첫 이력서면 대표 이력서가 된다. 한도에 걸리면 false.
 * [sqlite] FROM 없는 SELECT 에 바인딩한 값의 형: PostgreSQL 에서는 `?::integer` 같은 형 지정이 필요할 수 있다 (확인 필요).
 */
export async function insertResume(
  db: Db, r: { id: string; userId: string; title: string; lang: string; body: string; fileKey: string | null; ts: number }, max: number,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO resumes (id, user_id, title, lang, is_default, body, file_r2_key, created_at, updated_at)
     SELECT ?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM resumes WHERE user_id = ?) THEN 0 ELSE 1 END, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM resumes WHERE user_id = ?) < ?`,
  ).bind(r.id, r.userId, r.title, r.lang, r.userId, r.body, r.fileKey, r.ts, r.ts, r.userId, max).run();
  return res.meta.changes === 1;
}

/**
 * 내용 수정. 화면을 연 뒤 다른 창에서 고쳤으면(updated_at 이 다르면) 바꾸지 않는다 → false.
 * 같은 초에 두 번 저장하는 경우까지 막지는 못한다 (본인 혼자 쓰는 자료라 충분하다).
 */
export async function updateResume(
  db: Db, r: { id: string; userId: string; title: string; lang: string; body: string; fileKey: string | null; ts: number; expectedUpdatedAt: number },
): Promise<boolean> {
  const res = await db.prepare(
    'UPDATE resumes SET title = ?, lang = ?, body = ?, file_r2_key = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?',
  ).bind(r.title, r.lang, r.body, r.fileKey, r.ts, r.id, r.userId, r.expectedUpdatedAt).run();
  return res.meta.changes === 1;
}

/**
 * 대표 이력서 지정. 먼저 기존 대표를 내리고(대상이 내 이력서로 있을 때만) 대상을 올린다 — 순서를 바꾸면 고유 색인에 걸린다.
 * 대상이 없으면 아무것도 바뀌지 않는다 → false.
 */
export async function setDefaultResume(db: Db, id: string, userId: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare(
      `UPDATE resumes SET is_default = 0 WHERE user_id = ? AND is_default = 1 AND id != ?
         AND EXISTS (SELECT 1 FROM resumes WHERE id = ? AND user_id = ?)`,
    ).bind(userId, id, id, userId),
    db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ? AND user_id = ?').bind(id, userId),
  ]);
  return res[1]?.meta.changes === 1;
}

/**
 * 삭제. 대표 이력서를 지웠으면 남은 것 중 가장 최근에 고친 것이 대표가 된다 (같은 트랜잭션).
 * 지원서(applications.resume_snapshot)는 복사본이라 영향을 받지 않는다. R2 파일은 호출부가 지운다.
 */
export async function deleteResume(db: Db, id: string, userId: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare('DELETE FROM resumes WHERE id = ? AND user_id = ?').bind(id, userId),
    db.prepare(
      `UPDATE resumes SET is_default = 1
       WHERE id = (SELECT id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM resumes WHERE user_id = ? AND is_default = 1)`,
    ).bind(userId, userId),
  ]);
  return res[0]?.meta.changes === 1;
}

/** 회원 탈퇴(T-11)·정리 작업용: 그 회원의 이력서 파일 키 목록. */
export async function listResumeFileKeys(db: Db, userId: string): Promise<string[]> {
  const r = await db.prepare('SELECT file_r2_key FROM resumes WHERE user_id = ? AND file_r2_key IS NOT NULL').bind(userId).all<{ file_r2_key: string }>();
  return r.results.map((x) => x.file_r2_key);
}
