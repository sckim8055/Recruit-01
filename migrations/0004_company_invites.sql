-- 기업 담당자 초대와 반려 사유 (T-04).
-- 초대는 메일을 보내지 않는다. 초대받은 사람이 그 이메일로 기업 담당자 계정에 로그인하면 /biz 에서 수락할 수 있다.
CREATE TABLE company_invites (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  email       TEXT NOT NULL,                   -- 소문자로 정규화
  is_hq       INTEGER NOT NULL DEFAULT 0,      -- 1 = 중국 본사 소속으로 초대
  invited_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  accepted_at INTEGER                          -- NULL = 수락 대기
);
CREATE UNIQUE INDEX idx_company_invites_email ON company_invites(company_id, email);
CREATE INDEX idx_company_invites_pending ON company_invites(email, accepted_at);

-- 관리자가 반려할 때 적는 사유. 기업이 고쳐서 다시 제출하면(신원 항목 수정·서류 추가) 지운다.
ALTER TABLE companies ADD COLUMN reject_reason TEXT;
