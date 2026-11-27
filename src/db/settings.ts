// 사이트 설정 (site_settings, 0006). 이름 → 문자열 값. 값의 뜻·검사는 호출부(lib)가 한다 — 여기서는 받은 값으로 SQL 만 실행한다.
// 지금 쓰는 키: public_job_filters (lib/public-jobs.PUBLIC_FILTERS_SETTING), retention · retention.log (lib/retention, T-12c), maint.* (db/maintenance),
// limits · limits.log (lib/limits, T-17).
//
// ON CONFLICT (key) DO UPDATE … excluded 는 PostgreSQL 에서도 그대로 된다 (docs/DB-PORTING.md 3장).
import type { Db } from './types';

/** 설정값. 행이 없으면 null (호출부가 기본값을 쓴다). 기본 키 한 행만 읽는다. */
export async function getSetting(db: Db, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM site_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

/**
 * 설정값 여러 개를 한 번에 (기본 키 IN, 문장 하나 = D1 호출 하나). 없는 키는 null. 조건 알림 단계가 보일 필터 + 한도를
 * 하위 요청 하나로 읽으려고 쓴다 (T-17, docs/ARCHITECTURE.md 17-5).
 */
export async function getSettings<K extends string>(db: Db, keys: readonly K[]): Promise<Record<K, string | null>> {
  const out = Object.fromEntries(keys.map((k) => [k, null])) as Record<K, string | null>;
  if (!keys.length) return out;
  const rows = (await db.prepare(`SELECT key, value FROM site_settings WHERE key IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys).all<{ key: string; value: string }>()).results;
  for (const r of rows) if ((keys as readonly string[]).includes(r.key)) out[r.key as K] = r.value;
  return out;
}

/** 설정값 저장 (없으면 추가, 있으면 덮어쓰기). 누가·언제 바꿨는지 함께 남긴다. */
export async function setSetting(db: Db, key: string, value: string, userId: string, ts: number): Promise<void> {
  await db.prepare(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(key, value, userId, ts).run();
}

export interface SettingMeta { value: string; updated_by: string | null; updated_at: number; updated_by_email: string | null }

/** 설정값 + 누가(관리자 id·이메일)·언제 바꿨는지. 행이 없으면 null. 관리자 화면에서만 쓴다. */
export async function getSettingWithMeta(db: Db, key: string): Promise<SettingMeta | null> {
  return db.prepare(
    `SELECT s.value, s.updated_by, s.updated_at, u.email AS updated_by_email
     FROM site_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?`,
  ).bind(key).first<SettingMeta>();
}

/** 설정값 여러 개를 한 트랜잭션으로 저장 (보관 기간 + 그 변경 기록, T-12c). [sqlite] batch = 한 트랜잭션. */
export async function setSettings(db: Db, items: Array<{ key: string; value: string }>, userId: string, ts: number): Promise<void> {
  if (!items.length) return;
  await db.batch(items.map((i) => db.prepare(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(i.key, i.value, userId, ts)));
}
