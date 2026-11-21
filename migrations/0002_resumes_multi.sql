-- 이력서를 여러 개 저장하고 그중 하나를 대표 이력서로 지정할 수 있게 한다.
-- 0001 의 resumes 는 회원당 1개였다. 아직 데이터가 없으므로 다시 만든다.
DROP TABLE resumes;

CREATE TABLE resumes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,                   -- 구직자가 붙이는 이름 (예: "영업직용"). 기업에는 보이지 않는다
  is_default  INTEGER NOT NULL DEFAULT 0,      -- 1 = 대표 이력서
  body        TEXT NOT NULL,                   -- 🔒 항목별 JSON (docs/ARCHITECTURE.md 4장)
  file_r2_key TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_resumes_user ON resumes(user_id);
-- 대표 이력서는 회원당 하나만
CREATE UNIQUE INDEX idx_resumes_default ON resumes(user_id) WHERE is_default = 1;

-- 어떤 이력서로 지원했는지 (참고용. 기업이 보는 내용은 resume_snapshot 이고, 원본을 지워도 지원서는 남는다)
ALTER TABLE applications ADD COLUMN resume_id TEXT;
