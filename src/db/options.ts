// 직무·업계·근무지 선택 항목 (job_options, 0007). 판단은 lib/options.ts 가 한다 — 여기서는 받은 값으로 SQL 만 실행한다.
// 삭제 함수는 없다 (사용 종료만). kind·code 는 고치지 않는다 (공고에 저장된 값이므로).
//
// [sqlite] meta.changes(영향 행 수) → PostgreSQL 드라이버의 rowCount.
// [sqlite] active 는 INTEGER 0/1. PostgreSQL 에서 boolean 으로 바꾸면 아래 SQL 의 `active = 1`·`active = 0` 과 lib/options.buildOptionSet 을 고친다.
import type { OptionKind, OptionRow } from '../lib/options';
import type { Db } from './types';

/** 모든 종류·모든 행 (사용 종료 포함). 한 번에 읽는다 (약 50행). 정렬은 lib/options.buildOptionSet 이 한다. */
export async function listOptions(db: Db): Promise<OptionRow[]> {
  return (await db.prepare('SELECT kind, code, label_ko, label_zh, sort, active FROM job_options').all<OptionRow>()).results;
}

/** 새 항목. 같은 (kind, code) 가 이미 있으면 아무것도 하지 않고 false (화면을 연 뒤 다른 관리자가 먼저 추가한 경우). */
export async function insertOption(
  db: Db, x: { kind: OptionKind; code: string; label_ko: string; label_zh: string; sort: number; userId: string; ts: number },
): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO job_options (kind, code, label_ko, label_zh, sort, active, created_at, updated_at, updated_by)
     VALUES (?,?,?,?,?,1,?,?,?) ON CONFLICT (kind, code) DO NOTHING`,
  ).bind(x.kind, x.code, x.label_ko, x.label_zh, x.sort, x.ts, x.ts, x.userId).run();
  return r.meta.changes === 1;
}

/** 이름·순서 고치기 (kind·code·active 는 바꾸지 않는다). 없는 항목이면 false. */
export async function updateOption(
  db: Db, x: { kind: OptionKind; code: string; label_ko: string; label_zh: string; sort: number; userId: string; ts: number },
): Promise<boolean> {
  const r = await db.prepare(
    'UPDATE job_options SET label_ko = ?, label_zh = ?, sort = ?, updated_at = ?, updated_by = ? WHERE kind = ? AND code = ?',
  ).bind(x.label_ko, x.label_zh, x.sort, x.ts, x.userId, x.kind, x.code).run();
  return r.meta.changes === 1;
}

/**
 * 사용 종료(active = false) · 다시 사용(active = true). 한 문장으로 확인과 변경을 같이 한다.
 * - 사용 종료: 지금 사용 중이고, 같은 종류에 사용 중인 항목이 둘 이상일 때만 (마지막 하나는 끄지 않는다 — lib/options.retireProblem 과 같은 조건)
 * - 다시 사용: 지금 사용 종료 상태일 때만
 * 바뀌었으면 true.
 * [sqlite] D1 은 쓰기를 한 곳에서 순서대로 하므로 이 한 문장 가드가 안전하다. PostgreSQL(READ COMMITTED)에서는 서로 다른 두 항목을
 *          동시에 사용 종료하면 둘 다 "둘 이상 남음" 을 보고 마지막 하나까지 꺼질 수 있다 (docs/DB-PORTING.md 4장).
 */
export async function setOptionActive(
  db: Db, x: { kind: OptionKind; code: string; active: boolean; userId: string; ts: number },
): Promise<boolean> {
  const r = x.active
    ? await db.prepare(
      'UPDATE job_options SET active = 1, updated_at = ?, updated_by = ? WHERE kind = ? AND code = ? AND active = 0',
    ).bind(x.ts, x.userId, x.kind, x.code).run()
    : await db.prepare(
      `UPDATE job_options SET active = 0, updated_at = ?, updated_by = ?
       WHERE kind = ? AND code = ? AND active = 1
         AND (SELECT COUNT(*) FROM job_options WHERE kind = ? AND active = 1) > 1`,
    ).bind(x.ts, x.userId, x.kind, x.code, x.kind).run();
  return r.meta.changes === 1;
}

/**
 * 항목별 공고 수 (상태와 관계없이 그 code 를 가진 모든 공고). 관리자 화면용. 한 문장(UNION ALL)으로 세 종류를 센다.
 * 이 세 컬럼에는 인덱스가 없어 jobs 를 처음부터 끝까지 읽는다 — 관리자 화면에서만 쓰므로 둔다 (공고가 아주 많아지면 다시 본다).
 * [sqlite] COUNT(*) 가 숫자로 온다. PostgreSQL 에서는 bigint → 문자열일 수 있다 (`::int`, 확인 필요).
 */
export async function countOptionUsage(db: Db): Promise<{ kind: OptionKind; code: string; n: number }[]> {
  return (await db.prepare(
    `SELECT 'role_category' AS kind, role_category AS code, COUNT(*) AS n FROM jobs WHERE role_category IS NOT NULL GROUP BY role_category
     UNION ALL
     SELECT 'industry' AS kind, industry AS code, COUNT(*) AS n FROM jobs WHERE industry IS NOT NULL GROUP BY industry
     UNION ALL
     SELECT 'location' AS kind, location AS code, COUNT(*) AS n FROM jobs WHERE location IS NOT NULL GROUP BY location`,
  ).all<{ kind: OptionKind; code: string; n: number }>()).results;
}
