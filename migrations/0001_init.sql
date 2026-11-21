-- 1차(MVP) 스키마. 시간은 모두 unix 초(INTEGER). id 는 crypto.randomUUID().
-- 🔒 표시 컬럼은 애플리케이션에서 AES-GCM 으로 암호화한 문자열("v1.<iv>.<ct>")만 저장한다.

-- ───────── 회원·조직 ─────────
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,            -- 소문자로 정규화
  role        TEXT NOT NULL CHECK (role IN ('seeker','company','headhunter','admin')),
  locale      TEXT NOT NULL DEFAULT 'ko' CHECK (locale IN ('ko','zh')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  totp_secret TEXT,                            -- 🔒 관리자 전용 2단계 인증
  created_at  INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE auth_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                 -- sha256(토큰). 토큰 원문은 저장하지 않는다
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE consents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('terms','privacy','cross_border','marketing')),
  version      TEXT NOT NULL,
  ref_id       TEXT,                           -- cross_border 는 application id
  agreed_at    INTEGER NOT NULL,
  withdrawn_at INTEGER
);
CREATE INDEX idx_consents_user ON consents(user_id, type);

CREATE TABLE companies (
  id            TEXT PRIMARY KEY,
  name_ko       TEXT NOT NULL,
  name_zh       TEXT,
  biz_no        TEXT,                          -- 한국 사업자등록번호 (kr_entity)
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('kr_entity','cn_hq')),
  hq_name       TEXT,
  entry_stage   TEXT CHECK (entry_stage IN ('preparing','just_established','operating')),
  industry      TEXT,
  website       TEXT,
  profile_ko    TEXT,                          -- 기업 제공 소개 ("기업 제공" 으로 표시)
  verify_status TEXT NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','verified','rejected')),
  verified_at   INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE company_members (
  company_id  TEXT NOT NULL REFERENCES companies(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  member_role TEXT NOT NULL CHECK (member_role IN ('owner','member')),
  is_hq       INTEGER NOT NULL DEFAULT 0,      -- 1 = 중국 본사 소속 (국외 이전 동의가 있어야 지원서 열람)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX idx_company_members_user ON company_members(user_id);

CREATE TABLE agencies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  biz_no        TEXT,
  license_no    TEXT,                          -- 유료직업소개사업 등록번호
  verify_status TEXT NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','verified','rejected')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE agency_members (
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agency_id, user_id)
);

CREATE TABLE verification_docs (
  id            TEXT PRIMARY KEY,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('company','agency')),
  owner_id      TEXT NOT NULL,
  doc_type      TEXT NOT NULL,                 -- biz_cert / cn_license / agency_license
  r2_key        TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_vdocs_owner ON verification_docs(owner_type, owner_id);

-- ───────── 공고·지원 ─────────
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),   -- 실제 구인 기업 (필수)
  agency_id       TEXT REFERENCES agencies(id),             -- 헤드헌터 공고일 때만
  created_by      TEXT NOT NULL REFERENCES users(id),
  job_family      TEXT NOT NULL DEFAULT 'office' CHECK (job_family IN ('office','production')),
  title_ko        TEXT,
  body_ko         TEXT,
  source_zh       TEXT,                        -- 기업이 쓴 중국어 원문
  back_zh         TEXT,                        -- 한국어 초안을 다시 중국어로 옮긴 대조본
  localize_status TEXT NOT NULL DEFAULT 'draft' CHECK (localize_status IN ('draft','review','approved')),
  role_category   TEXT,
  industry        TEXT,
  location        TEXT,
  salary_min      INTEGER,                     -- 만원/년. 번역하지 않고 입력값 그대로 쓴다
  salary_max      INTEGER,
  salary_basis    TEXT CHECK (salary_basis IN ('severance_excluded','severance_included')),
  work_hours      TEXT,
  report_line     TEXT CHECK (report_line IN ('kr_head','cn_hq')),
  chinese_level   TEXT CHECK (chinese_level IN ('none','basic','business','native')),
  contact_email   TEXT,                        -- 구인자 연락처 (운영자 도메인 금지)
  company_name_public INTEGER NOT NULL DEFAULT 1,
  review_flag     TEXT,                        -- 기술유출 필터에 걸린 사유. NULL 이면 걸리지 않음
  review_cleared_by TEXT REFERENCES users(id), -- 관리자가 검토 후 통과시킴
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','blocked')),
  published_at    INTEGER,
  closes_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, job_family, published_at);
CREATE INDEX idx_jobs_company ON jobs(company_id);

CREATE TABLE seeker_profiles (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  name          TEXT,                          -- 🔒
  phone         TEXT,                          -- 🔒 선택
  chinese_level TEXT,
  desired_roles TEXT,                          -- JSON 배열
  industries    TEXT,                          -- JSON 배열
  location      TEXT,
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','anonymous_public')),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE resumes (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  body        TEXT NOT NULL,                   -- 🔒 항목별 JSON (docs/ARCHITECTURE.md 4장)
  file_r2_key TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  seeker_id         TEXT NOT NULL REFERENCES users(id),
  resume_snapshot   TEXT NOT NULL,             -- 🔒 지원 시점 이력서 복사본
  summary_zh        TEXT,                      -- 🔒 중국어 요약
  summary_approved_at INTEGER,                 -- 구직자가 요약본을 승인한 시각. NULL 이면 기업에 보이지 않는다
  cross_border_consent_at INTEGER,             -- 국외 이전 동의 시각. NULL 이면 본사 담당자 열람 불가
  status            TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','viewed','reviewing','interview','rejected','closed','withdrawn')),
  status_changed_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  purge_after       INTEGER,                   -- 공고 마감 후 보관 기한
  UNIQUE (job_id, seeker_id)
);
CREATE INDEX idx_applications_seeker ON applications(seeker_id);

CREATE TABLE application_events (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  event          TEXT NOT NULL CHECK (event IN ('viewed','summary_shared','interview_mail','reject_mail','auto_closed','withdrawn')),
  actor_id       TEXT REFERENCES users(id),
  at             INTEGER NOT NULL
);
CREATE INDEX idx_app_events ON application_events(application_id, at);

CREATE TABLE alerts (
  id         TEXT PRIMARY KEY,
  seeker_id  TEXT NOT NULL REFERENCES users(id),
  filter_json TEXT NOT NULL,
  frequency  TEXT NOT NULL CHECK (frequency IN ('daily','weekly')),
  last_sent_at INTEGER,
  created_at INTEGER NOT NULL
);

-- ───────── 운영 ─────────
-- 공고 번역 캐시 전용. 이력서 등 개인정보는 절대 넣지 않는다.
CREATE TABLE translations (
  source_hash TEXT NOT NULL,
  src_lang    TEXT NOT NULL,
  tgt_lang    TEXT NOT NULL,
  text        TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (source_hash, src_lang, tgt_lang)
);

CREATE TABLE email_log (
  id       TEXT PRIMARY KEY,
  to_hash  TEXT NOT NULL,                      -- 주소 원문은 남기지 않는다
  template TEXT NOT NULL,
  result   TEXT NOT NULL,
  sent_at  INTEGER NOT NULL
);

-- 이력서·검증 서류 열람 기록 (기업 담당자·관리자 모두). 2년 보관.
CREATE TABLE access_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES users(id),
  actor_role  TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('application','resume','verification_doc')),
  target_id   TEXT NOT NULL,
  reason      TEXT,                            -- 관리자는 필수
  at          INTEGER NOT NULL
);
CREATE INDEX idx_access_log_target ON access_log(target_type, target_id);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id),
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at  INTEGER NOT NULL
);
