-- 남용 방지 한도 (T-05c). 하루(한국 시간) 사용 횟수를 (범위, 대상, 날짜) 마다 센다.
-- scope   : 무엇을 세는지 — localize_company · localize_site · admin_localize_test · mail_company · mail_site (src/lib/quota.ts SCOPES)
-- subject : 누구의 횟수인지 — 기업 id · 관리자 user id · 사이트 전체는 글자 그대로 'site'.
--           id 만 넣는다. 이메일 주소·IP·이름 같은 개인정보는 넣지 않는다.
-- day     : 'YYYY-MM-DD' (한국 시간, UTC+9 — lib/quota.kstDay)
-- n       : 그날 쓴 횟수. 한도 안에서만 늘어난다 (src/db/usage.takeQuota 한 문장).
-- 35일이 지난 행은 예약 작업 dropOldRows 가 지운다 (src/db/maintenance.ts).
CREATE TABLE usage_counters (
  scope      TEXT NOT NULL,
  subject    TEXT NOT NULL,
  day        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject, day)
);

-- 정리 작업이 오래된 날짜를 찾는 인덱스 (기본 키는 scope 로 시작해 day 만으로는 쓰이지 않는다).
CREATE INDEX idx_usage_counters_day ON usage_counters(day);
