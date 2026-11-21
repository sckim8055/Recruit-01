-- T-10 조건 알림: 구직자가 직접 고른 /jobs 검색 조건을 저장하고, 그 조건에 맞는 새 공고를 메일로 받는다.
--
-- 표: 0001 에 이미 있는 alerts(id, seeker_id, filter_json, frequency, last_sent_at, created_at)를 그대로 쓰고 컬럼만 더한다.
--   회원 탈퇴(db/account.eraseUser)가 이미 `DELETE FROM alerts WHERE seeker_id = ?` 를 하므로 탈퇴 때 알림이 함께 지워진다.
--   새 표를 만들면 eraseUser(보호 파일)를 고쳐야 한다.
-- 해지 링크 토큰: 메일마다 새 무작위 토큰(32바이트)을 만들고 SHA-256 해시만 alert_unsub_tokens 에 남긴다 (원문은 메일에만 있다).
--   알림이 지워지면(탈퇴 포함) ON DELETE CASCADE 로 함께 지워진다 — 외래키가 eraseUser 의 DELETE 를 막지 않게.
-- 시간은 모두 unix 초. 이 파일의 문법은 PostgreSQL 에서도 그대로 된다 (ADD COLUMN … DEFAULT, CHECK, ON DELETE CASCADE).

ALTER TABLE alerts ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused'));
-- 멈춘 이유: user(본인이 멈춤) · unsubscribe(메일의 해지 링크) · failures(발송 실패 5번 연속). 켜져 있으면 NULL.
ALTER TABLE alerts ADD COLUMN paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('user','unsubscribe','failures'));
-- 다음에 보낼 차례 (한국 시간 09:00, 매주는 월요일 09:00 — lib/alerts.nextDueAt). 0 = 아직 정하지 않음(예약 작업이 보지 않는다).
ALTER TABLE alerts ADD COLUMN next_due_at INTEGER NOT NULL DEFAULT 0;
-- 여기까지 게재된 공고는 이미 확인했다 (다음 메일은 published_at > checked_until 인 공고만). 처음 값은 만든 시각.
ALTER TABLE alerts ADD COLUMN checked_until INTEGER NOT NULL DEFAULT 0;
-- 연속 발송 실패 수. 보내면 0, 5번이면 멈춤(paused_reason = 'failures').
ALTER TABLE alerts ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
-- 알림 메일 수신 동의: 시각과 그때 본 문구의 판 (lib/alerts.ALERT_OPTIN_VERSION). optin_at = 0 인 행에는 보내지 않는다.
ALTER TABLE alerts ADD COLUMN optin_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN optin_version TEXT NOT NULL DEFAULT '';
-- 본인이 마지막으로 바꾼 시각(만들기·빈도·멈춤·다시 켜기) 또는 시스템이 멈춘 시각. 12개월 정리의 기준.
ALTER TABLE alerts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- 예약 작업이 보낼 차례가 된 알림을 오래된 차례부터 읽는다 (status = 'active' AND next_due_at <= ?).
CREATE INDEX idx_alerts_due ON alerts(status, next_due_at);
-- 내 알림 목록·개수(5개 한도)·같은 조건 확인, 탈퇴 계정의 알림 정리.
CREATE INDEX idx_alerts_seeker ON alerts(seeker_id, created_at);

CREATE TABLE alert_unsub_tokens (
  token_hash TEXT PRIMARY KEY,                 -- sha256(토큰) 16진수. 토큰 원문은 저장하지 않는다
  alert_id   TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL                  -- 180일 지난 토큰은 예약 작업이 지운다 (그 뒤의 링크는 "만료" 안내)
);
CREATE INDEX idx_alert_tokens_alert ON alert_unsub_tokens(alert_id);
CREATE INDEX idx_alert_tokens_created ON alert_unsub_tokens(created_at);
