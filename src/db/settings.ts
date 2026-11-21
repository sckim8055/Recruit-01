// 사이트 설정 (site_settings, 0006). 이름 → 문자열 값. 값의 뜻·검사는 호출부(lib)가 한다 — 여기서는 받은 값으로 SQL 만 실행한다.
// 지금 쓰는 키: public_job_filters (lib/public-jobs.PUBLIC_FILTERS_SETTING).
//
// ON CONFLICT (key) DO UPDATE … excluded 는 PostgreSQL 에서도 그대로 된다 (docs/DB-PORTING.md 3장).

/** 설정값. 행이 없으면 null (호출부가 기본값을 쓴다). 기본 키 한 행만 읽는다. */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM site_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

/** 설정값 저장 (없으면 추가, 있으면 덮어쓰기). 누가·언제 바꿨는지 함께 남긴다. */
export async function setSetting(db: D1Database, key: string, value: string, userId: string, ts: number): Promise<void> {
  await db.prepare(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(key, value, userId, ts).run();
}
