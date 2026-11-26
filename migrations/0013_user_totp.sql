-- T-16 2단계 인증: 회원(구직자·기업 담당자)도 고를 수 있게, 관리자는 화면에서 재등록, 복구 코드.
--
-- - 2단계 인증이 켜졌다 = users.totp_secret 이 NULL 이 아니다 (관리자·회원 같은 컬럼, 🔒 암호문). 켠 시각은 totp_enabled_at.
-- - 로그인 2단계 대기는 0003 의 admin_totp_pending 을 회원에게도 쓴다 (이름은 그대로 둔다). chosen_role 은 로그인 화면에서 고른 유형
--   (2단계를 통과한 뒤 "다른 유형으로 가입된 이메일" 안내를 지금처럼 보이기 위해서만 쓴다, 권한과 무관).
-- - 로그인한 사람의 등록·재등록 대기는 totp_enrolments (회원 + 그 세션에 묶임). 세션이 지워지면(로그아웃·탈퇴·만료 정리) 함께 지워진다.
-- - 복구 코드는 해시만 저장한다 (SESSION_PEPPER + 회원 id 를 섞은 SHA-256, lib/recovery.ts). 원문은 만든 화면에 한 번만 보인다.
-- - 관리자가 회원의 2단계 인증을 초기화한 기록은 admin_actions (access_log 는 target_type CHECK 가 지원서·이력서·서류뿐이라 맞지 않는다).
-- 시간은 모두 unix 초. 이 파일의 문법은 PostgreSQL 에서도 그대로 된다 (ADD COLUMN … DEFAULT, REFERENCES … ON DELETE CASCADE, CHECK).

ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
-- 로그인한 상태에서 하는 2단계 확인(끄기·재등록 1단계·복구 코드 새로 만들기)의 회원별 시도 수. 15분에 5번 → 잠시 잠김.
-- totp_fail_since = 이번 15분 창이 시작된 시각. 성공하면 0 / NULL 로 돌린다. 코드·번호는 저장하지 않는다.
ALTER TABLE users ADD COLUMN totp_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_fail_since INTEGER;

ALTER TABLE admin_totp_pending ADD COLUMN chosen_role TEXT;

CREATE TABLE totp_enrolments (
  id         TEXT PRIMARY KEY,                 -- 무작위 UUID (쿠키·폼으로 주고받지 않는다 — 세션으로 찾는다)
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  secret_new TEXT NOT NULL,                    -- 🔒 등록 중인 새 비밀키(base32). 확인 번호가 맞으면 users.totp_secret 으로 옮긴다
  attempts   INTEGER NOT NULL DEFAULT 0,       -- 5번 틀리면 이 대기를 지운다
  expires_at INTEGER NOT NULL                  -- 10분
);
CREATE UNIQUE INDEX idx_totp_enrolments_session ON totp_enrolments(session_id);
CREATE INDEX idx_totp_enrolments_user ON totp_enrolments(user_id);

CREATE TABLE totp_recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                    -- sha256(SESSION_PEPPER|rc|회원 id|코드) 16진수. 코드 원문은 저장하지 않는다
  used_at    INTEGER,                          -- 쓴 시각. 한 번 쓰면 다시 받지 않는다 (UPDATE … WHERE used_at IS NULL 한 문장)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id, code_hash);

CREATE TABLE admin_actions (
  id             TEXT PRIMARY KEY,
  actor_id       TEXT NOT NULL REFERENCES users(id),
  action         TEXT NOT NULL CHECK (action IN ('totp_reset')),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  reason         TEXT NOT NULL,                -- 관리자가 입력한 사유 (10자 이상)
  at             INTEGER NOT NULL
);
CREATE INDEX idx_admin_actions_at ON admin_actions(at);
