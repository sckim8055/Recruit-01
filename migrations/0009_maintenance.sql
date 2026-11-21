-- 예약 작업 (T-12). 공고 자동 마감 안내와 보관 기한 정리에 쓰는 컬럼·인덱스.
-- 개인정보를 넣지 않는다.

-- 자동 마감 3일 전 안내 메일을 보낸 시각. NULL = 아직 보내지 않음.
-- 기업이 공고를 저장하면(원문·조건 저장, 현지화 결과 저장, 한국어 저장) 다시 NULL 이 된다 (src/db/jobs.ts) — 마감일·무수정 기간이 새로 시작되므로.
ALTER TABLE jobs ADD COLUMN close_notice_at INTEGER;

-- 정리 작업이 기한을 찾는 컬럼. 표가 커져도 전체를 읽지 않게 한다.
CREATE INDEX idx_applications_purge ON applications(purge_after);
CREATE INDEX idx_access_log_at ON access_log(at);
CREATE INDEX idx_email_log_sent ON email_log(sent_at);
