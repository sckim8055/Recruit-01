-- 사이트 설정 (T-06d). 운영자가 화면에서 바꾸는 작은 값들을 이름(key) → 값(value, 문자열) 으로 둔다.
-- 행이 없으면 코드의 기본값을 쓴다 (기본 행을 넣지 않는다).
-- 지금 쓰는 키: public_job_filters — /jobs 에 보일 검색 조건 이름의 JSON 배열 (lib/public-jobs.parseEnabledFilters).
-- 개인정보를 넣지 않는다.
CREATE TABLE site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
