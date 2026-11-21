-- 지원 (T-08).
-- 지원서의 첨부파일: 지원할 때 이력서 첨부파일을 복사해 지원서가 따로 가진다 (이력서를 고치거나 지워도 지원서의 파일은 그대로).
-- 값은 R2 키(rfiles/<무작위>)이고, 파일은 Worker 가 암호화한 바이트다 (lib/resume-files.ts). 파일명·종류는 암호화된 resume_snapshot 안에 있다.
ALTER TABLE applications ADD COLUMN file_r2_key TEXT;

-- 기업의 지원자 목록(T-09)·내 지원 현황에서 쓰는 조회.
CREATE INDEX idx_applications_job ON applications(job_id, created_at);
