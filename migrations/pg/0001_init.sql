-- PostgreSQL 16 스키마 (T-19). SQLite/D1 마이그레이션 migrations/0001~0013 을 모두 적용한 결과와 같은 표·컬럼(순서 포함)·제약·인덱스.
-- 예전 파일(migrations/*.sql)은 기록으로만 남기고 고치지 않는다. 이후의 DB 변경은 이 폴더(migrations/pg/)에 새 번호 파일로 더한다.
-- 적용: npm run db:migrate (scripts/db-migrate.mjs, 적용한 파일은 schema_migrations 에 남는다). 한 파일 = 한 트랜잭션.
--
-- SQLite 와 다르게 정한 것 (docs/DB-PORTING.md 6장):
-- - 정수 컬럼은 모두 BIGINT (unix 초가 2038년에 32비트를 넘는다). 앱은 node-postgres 에서 JS 숫자로 받는다 (src/db/pg.ts).
-- - 0/1 값(is_hq, mfa, is_default, active, company_name_public)은 BOOLEAN 이 아니라 BIGINT 0/1 그대로 (코드 변경 없음).
-- - 글자 컬럼은 모두 COLLATE "C" (바이트 순서) — SQLite 의 BINARY 와 같은 정렬·비교 (ORDER BY name_ko, id DESC 페이지, day < 'YYYY-MM-DD').
-- - 외래키·ON DELETE CASCADE·CHECK·부분 유일 인덱스(idx_resumes_default)는 SQLite 와 같다.
-- 🔒 표시 컬럼은 애플리케이션에서 AES-GCM 으로 암호화한 문자열("v1.<iv>.<ct>")만 저장한다.

CREATE TABLE users (
  id          TEXT COLLATE "C" PRIMARY KEY,
  email       TEXT COLLATE "C" NOT NULL UNIQUE,            -- 소문자로 정규화
  role        TEXT COLLATE "C" NOT NULL CHECK (role IN ('seeker','company','headhunter','admin')),
  locale      TEXT COLLATE "C" NOT NULL DEFAULT 'ko' CHECK (locale IN ('ko','zh')),
  status      TEXT COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  totp_secret TEXT COLLATE "C",                            -- 🔒 관리자 전용 2단계 인증
  created_at  BIGINT NOT NULL,
  last_login_at BIGINT,
  totp_last_step BIGINT,
  totp_enabled_at BIGINT,
  totp_fail_count BIGINT NOT NULL DEFAULT 0,
  totp_fail_since BIGINT);

CREATE TABLE auth_codes (
  email        TEXT COLLATE "C" PRIMARY KEY,
  code_hash    TEXT COLLATE "C" NOT NULL,
  expires_at   BIGINT NOT NULL,
  attempts     BIGINT NOT NULL DEFAULT 0,
  last_sent_at BIGINT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT COLLATE "C" PRIMARY KEY,                 -- sha256(토큰). 토큰 원문은 저장하지 않는다
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  mfa BIGINT NOT NULL DEFAULT 0);

CREATE TABLE consents (
  id           TEXT COLLATE "C" PRIMARY KEY,
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  type         TEXT COLLATE "C" NOT NULL CHECK (type IN ('terms','privacy','cross_border','marketing')),
  version      TEXT COLLATE "C" NOT NULL,
  ref_id       TEXT COLLATE "C",                           -- cross_border 는 application id
  agreed_at    BIGINT NOT NULL,
  withdrawn_at BIGINT
);

CREATE TABLE companies (
  id            TEXT COLLATE "C" PRIMARY KEY,
  name_ko       TEXT COLLATE "C" NOT NULL,
  name_zh       TEXT COLLATE "C",
  biz_no        TEXT COLLATE "C",                          -- 한국 사업자등록번호 (kr_entity)
  entity_type   TEXT COLLATE "C" NOT NULL CHECK (entity_type IN ('kr_entity','cn_hq')),
  hq_name       TEXT COLLATE "C",
  entry_stage   TEXT COLLATE "C" CHECK (entry_stage IN ('preparing','just_established','operating')),
  industry      TEXT COLLATE "C",
  website       TEXT COLLATE "C",
  profile_ko    TEXT COLLATE "C",                          -- 기업 제공 소개 ("기업 제공" 으로 표시)
  verify_status TEXT COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','verified','rejected')),
  verified_at   BIGINT,
  created_at    BIGINT NOT NULL,
  reject_reason TEXT COLLATE "C");

CREATE TABLE company_members (
  company_id  TEXT COLLATE "C" NOT NULL REFERENCES companies(id),
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  member_role TEXT COLLATE "C" NOT NULL CHECK (member_role IN ('owner','member')),
  is_hq       BIGINT NOT NULL DEFAULT 0,      -- 1 = 중국 본사 소속 (국외 이전 동의가 있어야 지원서 열람)
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE agencies (
  id            TEXT COLLATE "C" PRIMARY KEY,
  name          TEXT COLLATE "C" NOT NULL,
  biz_no        TEXT COLLATE "C",
  license_no    TEXT COLLATE "C",                          -- 유료직업소개사업 등록번호
  verify_status TEXT COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','verified','rejected')),
  created_at    BIGINT NOT NULL
);

CREATE TABLE agency_members (
  agency_id  TEXT COLLATE "C" NOT NULL REFERENCES agencies(id),
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (agency_id, user_id)
);

CREATE TABLE verification_docs (
  id            TEXT COLLATE "C" PRIMARY KEY,
  owner_type    TEXT COLLATE "C" NOT NULL CHECK (owner_type IN ('company','agency')),
  owner_id      TEXT COLLATE "C" NOT NULL,
  doc_type      TEXT COLLATE "C" NOT NULL,                 -- biz_cert / cn_license / agency_license
  r2_key        TEXT COLLATE "C" NOT NULL,
  review_status TEXT COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_by   TEXT COLLATE "C" REFERENCES users(id),
  reviewed_at   BIGINT,
  created_at    BIGINT NOT NULL
);

CREATE TABLE jobs (
  id              TEXT COLLATE "C" PRIMARY KEY,
  company_id      TEXT COLLATE "C" NOT NULL REFERENCES companies(id),   -- 실제 구인 기업 (필수)
  agency_id       TEXT COLLATE "C" REFERENCES agencies(id),             -- 헤드헌터 공고일 때만
  created_by      TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  job_family      TEXT COLLATE "C" NOT NULL DEFAULT 'office' CHECK (job_family IN ('office','production')),
  title_ko        TEXT COLLATE "C",
  body_ko         TEXT COLLATE "C",
  source_zh       TEXT COLLATE "C",                        -- 기업이 쓴 중국어 원문
  back_zh         TEXT COLLATE "C",                        -- 한국어 초안을 다시 중국어로 옮긴 대조본
  localize_status TEXT COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (localize_status IN ('draft','review','approved')),
  role_category   TEXT COLLATE "C",
  industry        TEXT COLLATE "C",
  location        TEXT COLLATE "C",
  salary_min      BIGINT,                     -- 만원/년. 번역하지 않고 입력값 그대로 쓴다
  salary_max      BIGINT,
  salary_basis    TEXT COLLATE "C" CHECK (salary_basis IN ('severance_excluded','severance_included')),
  work_hours      TEXT COLLATE "C",
  report_line     TEXT COLLATE "C" CHECK (report_line IN ('kr_head','cn_hq')),
  chinese_level   TEXT COLLATE "C" CHECK (chinese_level IN ('none','basic','business','native')),
  contact_email   TEXT COLLATE "C",                        -- 구인자 연락처 (운영자 도메인 금지)
  company_name_public BIGINT NOT NULL DEFAULT 1,
  review_flag     TEXT COLLATE "C",                        -- 기술유출 필터에 걸린 사유. NULL 이면 걸리지 않음
  review_cleared_by TEXT COLLATE "C" REFERENCES users(id), -- 관리자가 검토 후 통과시킴
  status          TEXT COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','blocked')),
  published_at    BIGINT,
  closes_at       BIGINT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  title_zh TEXT COLLATE "C",
  localize_engine TEXT COLLATE "C",
  localize_requested_at BIGINT,
  block_reason TEXT COLLATE "C",
  rev BIGINT NOT NULL DEFAULT 0,
  close_notice_at BIGINT);

CREATE TABLE seeker_profiles (
  user_id       TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id),
  name          TEXT COLLATE "C",                          -- 🔒
  phone         TEXT COLLATE "C",                          -- 🔒 선택
  chinese_level TEXT COLLATE "C",
  desired_roles TEXT COLLATE "C",                          -- JSON 배열
  industries    TEXT COLLATE "C",                          -- JSON 배열
  location      TEXT COLLATE "C",
  visibility    TEXT COLLATE "C" NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','anonymous_public')),
  updated_at    BIGINT NOT NULL
);

CREATE TABLE applications (
  id                TEXT COLLATE "C" PRIMARY KEY,
  job_id            TEXT COLLATE "C" NOT NULL REFERENCES jobs(id),
  seeker_id         TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  resume_snapshot   TEXT COLLATE "C" NOT NULL,             -- 🔒 지원 시점 이력서 복사본
  summary_zh        TEXT COLLATE "C",                      -- 🔒 중국어 요약
  summary_approved_at BIGINT,                 -- 구직자가 요약본을 승인한 시각. NULL 이면 기업에 보이지 않는다
  cross_border_consent_at BIGINT,             -- 국외 이전 동의 시각. NULL 이면 본사 담당자 열람 불가
  status            TEXT COLLATE "C" NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','viewed','reviewing','interview','rejected','closed','withdrawn')),
  status_changed_at BIGINT NOT NULL,
  created_at        BIGINT NOT NULL,
  purge_after       BIGINT,                    -- 공고 마감 후 보관 기한
  resume_id         TEXT COLLATE "C",          -- 0002: 어떤 이력서로 지원했는지 (참고용, 외래키 없음)
  file_r2_key       TEXT COLLATE "C",          -- 0008: 지원서 첨부 파일 키 (rfiles/<무작위>)
  keep_days         BIGINT,                    -- 0011: 지원할 때의 보관 일수
  UNIQUE (job_id, seeker_id)
);

CREATE TABLE application_events (
  id             TEXT COLLATE "C" PRIMARY KEY,
  application_id TEXT COLLATE "C" NOT NULL REFERENCES applications(id),
  event          TEXT COLLATE "C" NOT NULL CHECK (event IN ('viewed','summary_shared','interview_mail','reject_mail','auto_closed','withdrawn')),
  actor_id       TEXT COLLATE "C" REFERENCES users(id),
  at             BIGINT NOT NULL
);

CREATE TABLE alerts (
  id         TEXT COLLATE "C" PRIMARY KEY,
  seeker_id  TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  filter_json TEXT COLLATE "C" NOT NULL,
  frequency  TEXT COLLATE "C" NOT NULL CHECK (frequency IN ('daily','weekly')),
  last_sent_at BIGINT,
  created_at BIGINT NOT NULL,
  status TEXT COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  paused_reason TEXT COLLATE "C" CHECK (paused_reason IS NULL OR paused_reason IN ('user','unsubscribe','failures')),
  next_due_at BIGINT NOT NULL DEFAULT 0,
  checked_until BIGINT NOT NULL DEFAULT 0,
  fail_count BIGINT NOT NULL DEFAULT 0,
  optin_at BIGINT NOT NULL DEFAULT 0,
  optin_version TEXT COLLATE "C" NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0);

CREATE TABLE translations (
  source_hash TEXT COLLATE "C" NOT NULL,
  src_lang    TEXT COLLATE "C" NOT NULL,
  tgt_lang    TEXT COLLATE "C" NOT NULL,
  text        TEXT COLLATE "C" NOT NULL,
  model       TEXT COLLATE "C" NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (source_hash, src_lang, tgt_lang)
);

CREATE TABLE email_log (
  id       TEXT COLLATE "C" PRIMARY KEY,
  to_hash  TEXT COLLATE "C" NOT NULL,                      -- 주소 원문은 남기지 않는다
  template TEXT COLLATE "C" NOT NULL,
  result   TEXT COLLATE "C" NOT NULL,
  sent_at  BIGINT NOT NULL
);

CREATE TABLE access_log (
  id          TEXT COLLATE "C" PRIMARY KEY,
  actor_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  actor_role  TEXT COLLATE "C" NOT NULL,
  target_type TEXT COLLATE "C" NOT NULL CHECK (target_type IN ('application','resume','verification_doc')),
  target_id   TEXT COLLATE "C" NOT NULL,
  reason      TEXT COLLATE "C",                            -- 관리자는 필수
  at          BIGINT NOT NULL
);

CREATE TABLE reports (
  id          TEXT COLLATE "C" PRIMARY KEY,
  reporter_id TEXT COLLATE "C" REFERENCES users(id),
  target_type TEXT COLLATE "C" NOT NULL,
  target_id   TEXT COLLATE "C" NOT NULL,
  reason      TEXT COLLATE "C" NOT NULL,
  status      TEXT COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at  BIGINT NOT NULL
);

CREATE TABLE resumes (
  id          TEXT COLLATE "C" PRIMARY KEY,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  title       TEXT COLLATE "C" NOT NULL,                   -- 구직자가 붙이는 이름 (예: "영업직용"). 기업에는 보이지 않는다
  is_default  BIGINT NOT NULL DEFAULT 0,      -- 1 = 대표 이력서
  body        TEXT COLLATE "C" NOT NULL,                   -- 🔒 항목별 JSON (docs/ARCHITECTURE.md 4장)
  file_r2_key TEXT COLLATE "C",
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE TABLE admin_totp_pending (
  id         TEXT COLLATE "C" PRIMARY KEY,                 -- sha256(토큰). 토큰 원문은 쿠키에만 있다
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  secret_new TEXT COLLATE "C",                             -- 🔒 최초 등록 중인 비밀키(base32). 등록이 끝나면 users.totp_secret 으로 옮긴다
  attempts   BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  chosen_role TEXT COLLATE "C");

CREATE TABLE company_invites (
  id          TEXT COLLATE "C" PRIMARY KEY,
  company_id  TEXT COLLATE "C" NOT NULL REFERENCES companies(id),
  email       TEXT COLLATE "C" NOT NULL,                   -- 소문자로 정규화
  is_hq       BIGINT NOT NULL DEFAULT 0,      -- 1 = 중국 본사 소속으로 초대
  invited_by  TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  created_at  BIGINT NOT NULL,
  accepted_at BIGINT                          -- NULL = 수락 대기
);

CREATE TABLE site_settings (
  key        TEXT COLLATE "C" PRIMARY KEY,
  value      TEXT COLLATE "C" NOT NULL,
  updated_by TEXT COLLATE "C" REFERENCES users(id),
  updated_at BIGINT NOT NULL
);

CREATE TABLE job_options (
  kind       TEXT COLLATE "C" NOT NULL CHECK (kind IN ('role_category','industry','location')),
  code       TEXT COLLATE "C" NOT NULL,
  label_ko   TEXT COLLATE "C" NOT NULL,
  label_zh   TEXT COLLATE "C" NOT NULL,
  sort       BIGINT NOT NULL,
  active     BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT COLLATE "C" REFERENCES users(id),
  PRIMARY KEY (kind, code)
);

CREATE TABLE usage_counters (
  scope      TEXT COLLATE "C" NOT NULL,
  subject    TEXT COLLATE "C" NOT NULL,
  day        TEXT COLLATE "C" NOT NULL,
  n          BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (scope, subject, day)
);

CREATE TABLE alert_unsub_tokens (
  token_hash TEXT COLLATE "C" PRIMARY KEY,                 -- sha256(토큰) 16진수. 토큰 원문은 저장하지 않는다
  alert_id   TEXT COLLATE "C" NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL                  -- 180일 지난 토큰은 예약 작업이 지운다 (그 뒤의 링크는 "만료" 안내)
);

CREATE TABLE totp_enrolments (
  id         TEXT COLLATE "C" PRIMARY KEY,                 -- 무작위 UUID (쿠키·폼으로 주고받지 않는다 — 세션으로 찾는다)
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT COLLATE "C" NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  secret_new TEXT COLLATE "C" NOT NULL,                    -- 🔒 등록 중인 새 비밀키(base32). 확인 번호가 맞으면 users.totp_secret 으로 옮긴다
  attempts   BIGINT NOT NULL DEFAULT 0,       -- 5번 틀리면 이 대기를 지운다
  expires_at BIGINT NOT NULL                  -- 10분
);

CREATE TABLE totp_recovery_codes (
  id         TEXT COLLATE "C" PRIMARY KEY,
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT COLLATE "C" NOT NULL,                    -- sha256(SESSION_PEPPER|rc|회원 id|코드) 16진수. 코드 원문은 저장하지 않는다
  used_at    BIGINT,                          -- 쓴 시각. 한 번 쓰면 다시 받지 않는다 (UPDATE … WHERE used_at IS NULL 한 문장)
  created_at BIGINT NOT NULL
);

CREATE TABLE admin_actions (
  id             TEXT COLLATE "C" PRIMARY KEY,
  actor_id       TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  action         TEXT COLLATE "C" NOT NULL CHECK (action IN ('totp_reset')),
  target_user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  reason         TEXT COLLATE "C" NOT NULL,                -- 관리자가 입력한 사유 (10자 이상)
  at             BIGINT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_consents_user ON consents(user_id, type);

CREATE INDEX idx_company_members_user ON company_members(user_id);

CREATE INDEX idx_vdocs_owner ON verification_docs(owner_type, owner_id);

CREATE INDEX idx_jobs_status ON jobs(status, job_family, published_at);

CREATE INDEX idx_jobs_company ON jobs(company_id);

CREATE INDEX idx_applications_seeker ON applications(seeker_id);

CREATE INDEX idx_app_events ON application_events(application_id, at);

CREATE INDEX idx_access_log_target ON access_log(target_type, target_id);

CREATE INDEX idx_resumes_user ON resumes(user_id);

CREATE UNIQUE INDEX idx_resumes_default ON resumes(user_id) WHERE is_default = 1;

CREATE UNIQUE INDEX idx_company_invites_email ON company_invites(company_id, email);

CREATE INDEX idx_company_invites_pending ON company_invites(email, accepted_at);

CREATE INDEX idx_jobs_review ON jobs(review_flag, review_cleared_by);

CREATE INDEX idx_applications_job ON applications(job_id, created_at);

CREATE INDEX idx_applications_purge ON applications(purge_after);

CREATE INDEX idx_access_log_at ON access_log(at);

CREATE INDEX idx_email_log_sent ON email_log(sent_at);

CREATE INDEX idx_usage_counters_day ON usage_counters(day);

CREATE INDEX idx_alerts_due ON alerts(status, next_due_at);

CREATE INDEX idx_alerts_seeker ON alerts(seeker_id, created_at);

CREATE INDEX idx_alert_tokens_alert ON alert_unsub_tokens(alert_id);

CREATE INDEX idx_alert_tokens_created ON alert_unsub_tokens(created_at);

CREATE UNIQUE INDEX idx_totp_enrolments_session ON totp_enrolments(session_id);

CREATE INDEX idx_totp_enrolments_user ON totp_enrolments(user_id);

CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id, code_hash);

CREATE INDEX idx_admin_actions_at ON admin_actions(at);

-- 직무·업계·근무지 기본 항목 (0007 과 같은 49행, 시각만 PostgreSQL 식)
INSERT INTO job_options (kind, code, label_ko, label_zh, sort, active, created_at, updated_at, updated_by) VALUES
  ('role_category', 'sales', '영업', '销售', 10, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'marketing', '마케팅', '市场营销', 20, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'finance', '재무·회계', '财务与会计', 30, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'hr', '인사', '人力资源', 40, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'admin', '총무·사무', '行政与文员', 50, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'it', 'IT·개발', 'IT与开发', 60, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'engineering', '기술·엔지니어링', '技术与工程', 70, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'operations', '운영', '运营', 80, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'logistics', '물류', '物流', 90, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'purchasing', '구매', '采购', 100, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'legal', '법무', '法务', 110, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'customer', '고객 응대', '客户服务', 120, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'translation', '통번역', '翻译', 130, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'management', '경영·관리', '经营管理', 140, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('role_category', 'other', '기타', '其他', 150, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'electronics', '전자', '电子', 10, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'battery', '배터리', '电池', 20, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'auto', '자동차', '汽车', 30, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'machinery', '기계', '机械', 40, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'chemicals', '화학', '化工', 50, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'ecommerce', '전자상거래', '电子商务', 60, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'retail', '유통', '零售', 70, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'logistics', '물류', '物流', 80, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'trade', '무역', '贸易', 90, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'finance', '금융', '金融', 100, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'it_software', 'IT·소프트웨어', 'IT与软件', 110, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'gaming', '게임', '游戏', 120, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'consumer', '소비재', '消费品', 130, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'food', '식품', '食品', 140, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'travel', '여행·관광', '旅游', 150, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('industry', 'other', '기타', '其他', 160, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'seoul', '서울', '首尔', 10, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'gyeonggi', '경기', '京畿道', 20, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'incheon', '인천', '仁川', 30, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'busan', '부산', '釜山', 40, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'daegu', '대구', '大邱', 50, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'daejeon', '대전', '大田', 60, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'gwangju', '광주', '光州', 70, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'ulsan', '울산', '蔚山', 80, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'sejong', '세종', '世宗', 90, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'gangwon', '강원', '江原道', 100, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'chungbuk', '충북', '忠清北道', 110, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'chungnam', '충남', '忠清南道', 120, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'jeonbuk', '전북', '全罗北道', 130, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'jeonnam', '전남', '全罗南道', 140, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'gyeongbuk', '경북', '庆尚北道', 150, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'gyeongnam', '경남', '庆尚南道', 160, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'jeju', '제주', '济州', 170, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL),
  ('location', 'remote', '재택', '远程办公', 180, 1, extract(epoch from now())::bigint, extract(epoch from now())::bigint, NULL);
