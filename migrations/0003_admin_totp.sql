-- 관리자 2단계 인증(TOTP).
-- 같은 인증번호를 두 번 쓰지 못하게 마지막으로 통과한 시간 단계(30초 단위)를 기록한다.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

-- 이 세션이 TOTP 를 통과했는가. 관리자 권한은 mfa = 1 인 세션에서만 인정한다
-- (일반 회원으로 만든 세션이, 나중에 관리자로 지정됐다고 해서 관리자 세션이 되지 않게 한다).
ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0;

-- 이메일 인증코드는 통과했지만 TOTP 는 아직 통과하지 못한 관리자 로그인. 10분 유효, 5회 실패 시 폐기.
CREATE TABLE admin_totp_pending (
  id         TEXT PRIMARY KEY,                 -- sha256(토큰). 토큰 원문은 쿠키에만 있다
  user_id    TEXT NOT NULL REFERENCES users(id),
  secret_new TEXT,                             -- 🔒 최초 등록 중인 비밀키(base32). 등록이 끝나면 users.totp_secret 으로 옮긴다
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
