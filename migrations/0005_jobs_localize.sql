-- 공고 작성·현지화·게재 (T-05).
-- 중국어 원문은 제목(title_zh)과 본문(source_zh)을 나눠 저장한다. 0001 의 source_zh 는 본문만 담는다.
ALTER TABLE jobs ADD COLUMN title_zh TEXT;

-- 마지막으로 현지화 초안을 만든 엔진 id (workers_ai·gemini·claude 등). "다시 만들기" 는 그다음 엔진부터 시도한다.
-- 기업 화면에는 보여주지 않는다. 기업이 한국어를 직접 고쳐도 바꾸지 않는다.
ALTER TABLE jobs ADD COLUMN localize_engine TEXT;

-- 현지화 요청 시각. 같은 공고에서 짧은 간격으로 엔진을 반복 호출하지 못하게 한다 (비용 보호).
ALTER TABLE jobs ADD COLUMN localize_requested_at INTEGER;

-- 관리자가 차단할 때 적는 사유 (기업에 표시). 차단을 해제하면 지운다.
ALTER TABLE jobs ADD COLUMN block_reason TEXT;

-- 내용 버전. 기업이 내용을 바꿀 때마다 1 씩 올린다.
-- 화면을 연 뒤 내용이 바뀌었는지(승인·게재·관리자 검토 통과가 본 내용과 같은지) 확인하는 데 쓴다.
ALTER TABLE jobs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_jobs_review ON jobs(review_flag, review_cleared_by);
