-- T-22: 이력서 작성 언어. 구직자가 이력서마다 고른다 ("작성 언어: 한국어 / 中文"). 번역은 하지 않는다 (규칙 6, T-14 는 플래그 뒤).
-- 개인정보가 아니므로 평문으로 둔다 (본문 body·resume_snapshot 은 그대로 암호문).
-- - resumes.lang: 이력서 원본의 작성 언어. 이전에 만든 이력서는 'ko'.
-- - applications.resume_lang: 지원할 때 고른 이력서의 작성 언어 (지원서 복사본 JSON 의 lang 과 같은 값).
--   기업 지원자 목록은 지원서를 열지 않고(열람 기록·'viewed' 없이) 이 값으로 "한국어 이력서 / 中文简历" 표시만 한다.
--   이전 지원은 'ko' (복사본에 lang 이 없는 예전 지원서도 'ko' 로 읽는다 — lib/resume.snapshotLang).
ALTER TABLE resumes ADD COLUMN lang TEXT COLLATE "C" NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko','zh'));
ALTER TABLE applications ADD COLUMN resume_lang TEXT COLLATE "C" NOT NULL DEFAULT 'ko' CHECK (resume_lang IN ('ko','zh'));
