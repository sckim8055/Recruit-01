# 아키텍처

기획서·기술설계서(Claude 문서 "중국기업 한국진출 채용정보 서비스 기획서")의 결정을 코드 구조로 옮긴 문서다.
코드와 이 문서가 다르면 이 문서를 먼저 고치고 운영자 확인을 받는다.

## 1. 한 장 요약

- **무엇:** 한국에 진출한 중국기업의 채용 공고와 기업 정보를 보여주는 사이트. 기업은 중국어로 공고를 쓰고, 구직자는 한국어로 본다.
- **법적 형태:** 직업정보제공사업. 직업소개(알선)는 하지 않는다. 구직자와 기업은 직접 연결된다.
- **구성:** Cloudflare Worker 하나(Hono). 화면은 서버 렌더링, DB 는 D1, 파일은 R2, 메일은 Resend, 번역은 현지화 엔진 층(Claude · Gemini · Workers AI 중 설정으로 선택, 7절).
- **환경:** dev(로컬) → test(recruit.kimbbob.xyz, 가짜 데이터) → production(kimbbob.com, 신고 후).

```
브라우저(한국·중국) ──▶ Cloudflare Worker (src/index.tsx)
                          ├─ 정적 파일 public/
                          ├─ D1  (migrations/)
                          ├─ R2  (이력서 파일·검증 서류, 비공개)
                          └─ 외부 API: Resend · 현지화 엔진(Claude·Gemini·Workers AI) · 국세청 사업자 상태조회   ← Worker 에서만 호출
```

기술설계서는 Pages + Workers 로 적었지만, 배포 단위를 하나로 줄이기 위해 **정적 파일을 포함한 Worker 하나**로 구현했다. 기능 차이는 없다.

## 2. 폴더 구조

```
src/
  index.tsx          진입점. 미들웨어 순서: 보안 헤더 → 출처 검사 → 세션 → 언어
  env.ts             바인딩·타입·기능 플래그
  render.tsx         공통 레이아웃에 넣어 응답
  lib/
    rules.ts         ★ 법적 규칙 (게재 가능 여부, 금지 표현, 기술유출 필터, 지원 상태 계산) — 순수 함수
    authz.ts         ★ 열람·수정 권한 — 순수 함수
    auth.ts          이메일 인증코드 로그인, 세션, 역할 검사, CSRF
    crypto.ts        AES-GCM 암호화, 해시, 인증코드·토큰 생성
    email.ts         Resend 발송 + email_log
    i18n.ts          언어 판별, 문구 조회
    jobs.ts          공고 폼 검사, 저장 시 상태 계산(planJobSave), 숫자 대조 — 순수 함수
    public-jobs.ts   공개 공고 조건(isPubliclyVisible)·필터·페이지 — 순수 함수 (9절)
    options.ts       직무·업계·근무지 선택 항목(이름 표시·고를 수 있는 값·관리자 입력 검사) — 순수 함수 (10절)
    page-cache.ts    공개 화면 캐시 (비로그인만, 60초) (9절)
    resume.ts · resume-files.ts  이력서 항목 검사·암호화, 첨부파일 검사·암호화·R2 (4절)
    application.ts · application-files.ts  지원 가능 여부·국외 이전 동의·복사본·취소, 지원서 첨부 내려받기 (11절)
    localize/        현지화 엔진 층 (7절)
  db/                SQL 과 D1 호출은 여기에만 (T-05d). users · sessions(인증코드·세션·TOTP 대기) · companies(기업·담당자·초대·서류 행)
                     · jobs · public-jobs(공개 공고 읽기) · logs(access_log·email_log) · admin(개수) · settings(site_settings) · options(job_options) · resumes(이력서)
                     · applications(지원·동의·취소) · application-views(지원 현황 화면용 읽기). 판단은 하지 않고 받은 값으로 SQL 만 실행한다.
                     PostgreSQL 로 옮길 때 고칠 곳과 SQLite 전용 문법 목록은 docs/DB-PORTING.md
  locales/ko.ts zh.ts  화면 문구
  routes/            화면·API 라우트 (기능별 파일)
  views/             JSX 화면 조각
migrations/          D1 스키마 (번호 순서, 기존 파일 수정 금지)
public/              정적 파일 (app.css). 외부 폰트·스크립트 없음
test/                vitest. rules·authz·crypto 는 반드시 테스트한다
docs/                이 문서, API.md, TASKS.md
```

★ 표시 두 파일이 이 서비스의 안전장치다. 라우트는 판단을 직접 하지 않고 이 두 파일의 함수를 호출한다.
라우트·lib 는 `env.DB` 를 직접 쓰지 않고 `src/db/` 의 함수에 넘기기만 한다 (`test/db-layer.test.ts` 가 검사한다).

## 3. 회원과 권한

| 역할 | 가입 | 검증 | 비고 |
|---|---|---|---|
| seeker (구직자) | 이메일 인증코드 | 없음 | |
| company (기업 담당자) | 이메일 인증코드 | 사업자 서류 + 국세청 상태조회 + 관리자 승인 | 검증 전에는 초안만 작성 |
| headhunter | `FLAG_HEADHUNTER_POSTING` 이 켜진 뒤에만 가입 | 유료직업소개사업 등록증 + 관리자 승인 | 현재 꺼짐 |
| admin (운영자) | DB 에서 직접 지정 | TOTP 2단계 (T-03) | 세션 12시간 |

- 한 기업에 담당자를 여럿 둘 수 있다 (`company_members`). 중국 본사 소속은 `is_hq = 1`.
- 본사 소속 담당자는 **국외 이전 동의가 있는 지원서만** 볼 수 있다 (`authz.canViewApplication`).
- 관리자는 공고 내용을 고칠 수 없고 차단만 한다. 이력서는 사유를 입력해야 열리고 `access_log` 에 남는다.

## 4. 데이터

스키마는 `migrations/` 의 파일을 번호 순서대로 적용한 결과가 기준이다. 주석에 🔒 가 붙은 컬럼은 암호문만 저장한다.

- **이력서는 회원당 여러 개(최대 5개)** 저장할 수 있고, 하나를 대표 이력서(`is_default`)로 지정한다. 지원할 때 어느 이력서로 낼지 고르며, 기본 선택은 대표 이력서다.
- **이력서는 간단하게 받는다.** 한국식 상세 이력서 양식을 강요하지 않는다. 필수는 아래 5개뿐이고, 나머지는 첨부파일로 대신한다.
  ```
  필수: name(이름) · chinese_level(중국어 수준) · years(총 경력 연차) · headline(한 줄 소개, 100자) · 연락 이메일(계정 이메일 기본값)
  선택: phone · desired_role(희망 직무) · experience_text(경력 요약, 자유 서술 1칸) · 첨부파일 1개(PDF·DOCX, 5MB, Worker 에서 암호화해 R2 비공개 저장)
  ```
  `resumes.body` 에는 위 항목을 JSON 으로 묶어 암호화해 저장하고(`lib/resume.sealResume`), 첨부파일은 `file_r2_key` 로 가리킨다.
  - **첨부파일 정보(원래 파일명·종류·크기)는 암호화된 `body` 안의 `file` 에 있다.** 파일명에 이름이 들어 있는 경우가 많기 때문이다.
    R2 키는 `rfiles/<무작위 UUID>` 이고 R2 객체에는 파일명·종류를 남기지 않는다. 평문으로 남는 것은 `title`(구직자가 붙인 이름표, 화면에서 개인정보를 쓰지 말라고 안내)과 `file_r2_key` 뿐이다.
  - **첨부파일 바이트도 Worker 에서 `ENC_KEY` 로 AES-GCM 암호화한 뒤 R2 에 넣는다** (`lib/resume-files.ts`, R2 키를 추가 인증 데이터로 써서 다른 위치로 옮긴 객체는 풀리지 않는다).
    R2 버킷을 직접 열어도 내용이 보이지 않는다. 크기 한도는 기술설계서의 10MB 대신 **5MB**(무료 플랜 CPU 한도 안에서 암호화·복호화하기 위해), 종류는 내용으로 판별한 **PDF·DOCX 만**(HWP·DOC·이미지는 PDF 로 저장해 올리도록 안내).
  - 이력서마다 자기 R2 객체를 가진다(복사하면 새 키로 다시 암호화). 새 파일은 R2 에 먼저 올리고 DB 를 쓰며, DB 쓰기가 실패하면 방금 올린 파일을 지운다.
    교체·삭제된 예전 객체는 DB 가 더 이상 가리키지 않게 된 **뒤에** 지운다. R2 삭제가 실패하면 어느 행도 가리키지 않는 객체가 남을 수 있다 → T-12 정리 작업.
  첨부파일 또는 experience_text 중 하나는 있어야 지원할 수 있다.
- 이력서 원본은 본인만 보고 고친다(`authz.canViewResume`·`canEditResume`). 기업·헤드헌터는 원본을 볼 수 없고 지원서(복사본)만 본다. 관리자 열람(사유 필요)은 함수만 있고 화면은 아직 없다.
- **번역 API 로 보내는 것은 headline·experience_text·desired_role·chinese_level·years 뿐이다.** 이름·연락처와 **첨부파일은 보내지 않는다**
  (파일 안에는 주민번호·주소·사진 같은 정보가 들어 있을 수 있다). 그래서 중국어 요약(`FLAG_RESUME_ZH_SUMMARY`)은 입력 항목만으로 만든다.
- **지원서(`applications.resume_snapshot`)** 는 지원 시점의 이력서 복사본이다. 지원 화면에서 이번 지원에만 쓸 내용으로 고쳐서 낼 수 있고, 이후 이력서를 고치거나 지워도 지원서는 바뀌지 않는다.
- **상태(`applications.status`)** 는 `application_events` 에서 `rules.nextStatus()` 로 계산해 저장한다.
- **`translations`** 는 공고 번역 캐시 전용이다. 개인정보를 넣지 않는다.
- **보관:** 지원서는 공고 마감 후 180일(`purge_after`), 검증 서류 원본은 1년, 열람 기록은 2년. 숫자는 개인정보처리방침 확정 때 다시 본다.

## 5. 법적 규칙이 코드에 있는 위치

| 규칙 | 코드 |
|---|---|
| 서류 미제출(미검증) 기업의 공고 게재 금지 | `rules.publishBlocks` → `company_not_verified` |
| 구인자 연락처 필수, 운영자 연락처 금지 | `rules.contactEmailProblem` (`OPERATOR_DOMAINS`) |
| "취업상담·추천·지원·알선" 표현 금지 | `rules.findBannedPhrases` |
| 신고번호 없이 운영 환경에서 게재 금지 | `publishBlocks` → `not_registered` (`REGISTRATION_NO`) |
| 핵심기술 R&D·특정 기업 출신 겨냥 공고 | `rules.techLeakFlag` → 관리자 검토 |
| 이력서 발송 대행·추천 금지 | 그런 기능을 만들지 않는다 (CLAUDE.md 규칙 1) |
| 연봉 표기에 퇴직금 포함/별도 명시 | `publishBlocks` → `salary_basis_missing` |
| 광고성 메일은 동의자에게만 | `consents.type = 'marketing'` 확인 후 발송 |

### 기능 플래그 (기본값 모두 off)

| 플래그 | 켜면 | 켜기 전 조건 |
|---|---|---|
| `FLAG_HEADHUNTER_POSTING` | 헤드헌터 가입·공고 등록 | 고용노동부(1350) 확인. 켠 뒤에는 지원 화면에 "이력서를 받는 곳"을 표시 |
| `FLAG_RESUME_ZH_SUMMARY` | 이력서 중국어 요약·본사 공유 | 1350 확인(알선 해당 여부), 국외 이전 동의 문구 확정 |
| `FLAG_PRODUCTION_JOBS` | 생산직 공고 등록·노출 | 운영자 결정 |
| `FLAG_PAID_LABEL` | "유료 제작" 표시 | 유료 제작물을 처음 게재하는 시점에 반드시 켠다 |

## 6. 환경

| 환경 | 주소 | 데이터 | 메일 |
|---|---|---|---|
| dev | localhost:8787 | 로컬 D1(가짜) | 콘솔 출력 |
| test | recruit.kimbbob.xyz (Cloudflare Access 로 운영자만) | 가짜만 | Resend 또는 콘솔 |
| production | kimbbob.com | 실제 | Resend (kimbbob.com SPF/DKIM/DMARC) |

- production 은 `wrangler.jsonc` 에 `env.production` 으로 별도 D1·R2 를 둔다 (T-13). test 와 DB·버킷을 공유하지 않는다.
- 비밀값(`ENC_KEY`, `SESSION_PEPPER`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`)은 `wrangler secret put` 으로 환경마다 따로 넣는다.
- `ENC_KEY` 를 잃으면 이력서와 백업을 복구할 수 없다. 운영자는 오프라인 사본을 보관한다.
- 무료 플랜 한도: Workers 요청 10만/일·CPU 10ms/요청, D1 읽기 500만 행/일·쓰기 10만 행/일. 실제 이력서를 받는 시점부터는 유료 플랜(월 5달러)을 권장한다.

## 7. 공고 현지화 (T-05)

흐름: 기업이 중국어로 제목·본문 작성 → 현지화 엔진이 한국어 초안을 만들고, **별도 호출**로 그 한국어를 다시 중국어로 옮긴 대조본(`back_zh`)을 만든다

**옮기는 방식(운영자 결정):** 구성은 원문 그대로 두고 문장만 한국어로 옮긴다. 원문에 없는 소제목을 만들거나 문단 순서를 바꾸지 않고, 중국의 제도·용어(五险一金 등)는 한국의 비슷한 제도 이름으로 바꾸지 않고 뜻을 풀어 쓴 뒤 원어를 괄호로 남긴다. 번역자 메모("[참고]" 등)는 넣지 않는다. 지시문은 `src/lib/localize/prompt.ts`.
→ 기업이 원문 | 한국어 | 대조본을 나란히 보고 승인 → `publishBlocks()` 가 빈 배열이면 게재. 연봉·근무시간·근무지 등은 구조 항목으로 받아 번역하지 않는다.

- **엔진 층** `src/lib/localize/`: `types.ts`(LocalizeEngine 인터페이스), `prompt.ts`(프롬프트·JSON 출력 해석), `index.ts`(순서·시간 제한·`localizeJob`),
  `registry.ts`(엔진 목록), `engines/`(claude · gemini · workers_ai, OpenAI 호환 엔진 만들기 `openai-compat.ts`).
- **순서:** `LOCALIZE_ENGINE` 이 쓸 수 있으면 먼저, 나머지는 claude → gemini → workers_ai 중 키·바인딩이 있는 것. 엔진당 한 번(재시도 없음), 호출당 25초,
  전체 55초를 넘기면 다음 엔진을 시작하지 않는다. "다시 만들기" 는 지난번 엔진(`jobs.localize_engine`) 다음부터. 모두 안 되면 수동 입력.
- **보내는 것:** 중국어 제목·본문뿐. 원문에 이메일·전화번호가 있으면 저장 단계에서 거부한다. 연락처·연봉 등 구조 항목은 프롬프트에 넣지 않는다.
- **출력:** JSON 만 받는다. 빈 값·JSON 아님·길이 초과는 실패로 보고 다음 엔진으로. 엔진 출력은 믿을 수 없는 글이므로 화면에는 JSX 이스케이프로만 출력한다.
- **기록:** 콘솔에는 엔진 id 와 오류 종류(HTTP 상태)만. 기업 화면에는 엔진 이름을 보여주지 않는다(관리자 화면에만).
- **캐시:** `translations` 테이블은 쓰지 않는다 (결과는 공고 행에 저장되고, "다시 만들기" 는 새 결과가 필요하다).
- **변수:** `LOCALIZE_ENGINE`, `LOCALIZE_CLAUDE_MODEL`, `LOCALIZE_GEMINI_MODEL`, `LOCALIZE_WORKERS_AI_MODEL`(비우면 코드 기본값). 비밀값 `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
  Workers AI 는 `wrangler.jsonc` 의 `"ai"` 바인딩을 켜야 한다(로그인 필요, 로컬 `wrangler dev` 에서도 원격 호출).
- **상태:** 원문·한국어가 바뀌면 `localize_status = review`, 게재 중이면 미게재로(`jobs.planJobSave`). 기업이 한국어를 직접 고치면 대조본을 지운다.
  숫자 대조(`jobs.digitDiff`)는 경고만 하고 게재 조건이 아니다. 모든 쓰기는 `jobs.rev`(내용 버전)가 화면을 연 때와 같을 때만 반영한다.

## 8. 아직 정해지지 않은 것

- 1350 답변에 따라 바뀌는 것: 헤드헌터 공고, 이력서 중국어 요약, 통역 서비스, 한국법인 없는 본사의 검증 서류(营业执照).
- 브랜드명: 화면의 `Recruit` 는 임시다 (`src/locales/` 의 `site.name`).
- Cloudflare Turnstile(봇 방지): 중국 접속 테스트 뒤 결정. 지금은 발송 횟수 제한만 있다.

## 9. 공개 공고 화면 (T-06)

- **공개 조건 (한 곳):** `lib/public-jobs.isPubliclyVisible` 과 같은 뜻의 SQL `db/public-jobs.publicJobWhere` 만 쓴다 (목록·상세·홈 모두).
  `status = 'published'` · 기업 `verify_status = 'verified'` · `agency_id IS NULL`(헤드헌터 공고는 T-15 전까지 노출 안 함) ·
  `job_family = 'office'`(생산직은 `FLAG_PRODUCTION_JOBS` 가 켜졌을 때만) · `closes_at` 이 없거나 지금보다 뒤.
  두 쪽이 어긋나지 않는지 `test/public-jobs.test.ts` 가 SQLite 메모리 DB 에서 모든 조합을 비교한다.
  조건을 만족하지 않는 공고의 상세는 보통의 404 (있는지 알리지 않는다). 게재 판단 자체는 여전히 `publishBlocks` 만 한다.
- **공개 컬럼만:** 공개 질의는 한국어 제목·본문, 구조 항목, 연락처, 기업명·진출 단계만 읽는다. 원문(`title_zh`·`source_zh`)·대조본·검토·차단 사유·엔진은 읽지 않는다.
  `company_name_public = 0` 이면 기업 이름·id 를 SQL 에서부터 NULL 로 받아 "기업명 비공개" 로 표시하고 기업 페이지로 연결하지 않는다.
- **언어:** 공고 글은 한국어로만 게재된다. 중국어 화면도 제목·본문은 한국어 그대로이고 화면 문구만 중국어다.
- **연락·지원:** 상세에는 기업이 입력한 연락처(mailto)와 지원 칸(11절)을 둔다. 비로그인(캐시되는 화면)의 지원 칸은 누구에게나 같은 "지원하기" 링크뿐이다 — 캐시된 HTML 에 사용자별 내용이 들어가지 않게.
- **캐시 (`lib/page-cache.ts`):** `/`, `/jobs`, `/jobs/:id` 의 **로그인 쿠키(sid)가 없는** GET 만 Workers Cache API(`caches.default`)에 **60초** 저장한다.
  - 키 = 경로 + 이름순으로 정렬한 검색 조건 + 판별된 언어(`?lang=` → `lang` 쿠키 → Accept-Language). 같은 주소도 언어마다 따로 저장된다.
  - 응답 머리글 `Cache-Control: public, max-age=60`, `Vary: Cookie, Accept-Language` (브라우저가 언어 쿠키·로그인 쿠키가 바뀐 뒤 저장해 둔 화면을 다시 쓰지 않게).
    200 이고 Set-Cookie 가 없는 응답만 저장한다. 404·302 는 `private, no-store`.
  - 로그인 쿠키가 있으면(만료된 쿠키라도) 캐시를 읽지도 쓰지도 않고 `private, no-store` (머리글에 계정 메뉴가 나오므로).
  - 필터 폼은 빈 칸도 보내므로 `/jobs` 는 정규화 주소(`jobsHref`)가 아니면 302 로 보내 같은 조건이 한 캐시 항목을 쓰게 한다.
    숨긴 필터(아래 "보일 필터")도 정규화 주소에서 빠지므로 캐시 키에 설정을 따로 넣지 않는다.
  - **알려진 한계:** 마감·차단·게재 중단·기업 승인 취소된 공고도 **최대 60초** 캐시에서 보일 수 있다 (마감일이 지난 공고도 마찬가지).
    그래서 TTL 을 짧게 둔다. 배포 직후에도 이전 화면이 최대 60초 보일 수 있다. Cache API 는 데이터센터별이라 지역마다 따로 채워진다.
  - `X-Page-Cache: hit | miss | bypass` 머리글로 확인할 수 있다.
- **페이지:** 20건씩, `published_at DESC, id DESC`. 전체 개수를 세지 않고 21건을 읽어 다음 페이지 여부만 안다. 100페이지(2,000건) 넘게는 줄인다.
- **인덱스:** 기본 목록(생산직 플래그 꺼짐)은 기존 `idx_jobs_status(status, job_family, published_at)` 를 최신 순으로 읽고 LIMIT 에서 멈춘다
  (같은 게재 시각 안에서만 id 로 정렬). 필터는 이 순서로 읽으며 조건을 확인한다. 공고가 많아지면 T-06c 에서 다시 본다.
- **보일 필터 (T-06d):** `/jobs` 검색 칸에 어떤 조건을 보일지는 관리자가 `/admin/settings` 에서 고른다 (코드 수정 없이).
  - 저장: `site_settings`(0006, 이름 → 문자열 값) 의 `public_job_filters` = 보일 필터 이름의 JSON 배열. 읽고 쓰는 곳은 `db/settings.ts`(`getSetting`·`setSetting`, upsert, `updated_by`·`updated_at`).
  - 해석: `lib/public-jobs.parseEnabledFilters`. 행이 없으면 **기본값 `chinese_level`·`report_line`·`location`** (공고가 적은 초기에 조건 7개는 헷갈리므로).
    JSON 이 아니거나 배열이 아니면 기본값, 배열 안의 모르는 이름은 버린다. 빈 배열은 "검색 칸 없음" 이다. 표시 순서는 저장 순서와 관계없이 `FILTER_KEYS` 순서.
  - 동작: 숨긴 필터는 **모르는 검색 조건과 똑같이** 다룬다 — `parseJobFilter`·`canonicalJobsHref` 에 보일 필터 목록을 넘겨, 걸러지지 않고 적용 개수에도 들지 않으며
    정규화 302 에서 주소에서 빠진다 (예전에 저장한 주소도 그 조건 없이 열린다). 하나도 없으면 검색 칸(폼·검색 버튼·적용 개수)을 그리지 않는다.
    목록 줄·상세·공고 작성 폼·홈은 바뀌지 않는다 (숨긴 조건도 공고 내용에는 그대로 보인다).
  - 읽기: 캐시에 없는 `/jobs` 요청(302 포함)마다 기본 키 한 행을 읽는다. 비로그인 캐시 hit 은 D1 을 읽지 않는다. 설정을 따로 캐시하지 않는다(메모리 전역 없음).
  - **반영 시간:** 설정을 바꿔도 비로그인 방문자에게는 이미 캐시된 화면이 **최대 60초**(page-cache TTL, 브라우저 `max-age=60` 도 같다) 보인다.
    그동안은 숨긴 필터가 붙은 예전 주소의 캐시된 화면(걸러진 목록·예전 검색 칸)도 그대로 보일 수 있다. 캐시를 지우지 않고 TTL 로 만료되기를 기다린다.
    로그인한 사용자(관리자 포함)는 캐시를 거치지 않으므로 바로 바뀐다.

## 10. 직무·업계·근무지 항목 (T-06e)

- **저장:** `job_options`(0007) — `(kind, code)` 기본 키, `kind` 는 `role_category`·`industry`·`location`, 이름 `label_ko`·`label_zh`, 순서 `sort`(작은 수가 먼저, 같으면 code), `active`(0/1), `updated_by`·`updated_at`.
  0007 이 이전 코드의 상수·문구 49개를 넣었다. 이 표가 세 목록의 유일한 출처다 (코드 상수·`job.role.*` 등 문구는 없다).
  `jobs.role_category`·`industry`·`location` 은 code 를 담는 평범한 TEXT 다 (외래키 없음).
- **지우지 않는다.** 관리자는 추가·이름/순서 수정·사용 종료·다시 사용만 한다 (`/admin/options`). code·kind 는 만든 뒤 바꿀 수 없다.
  종류마다 사용 중인 항목이 하나는 남아야 한다 (`lib/options.retireProblem` + `db/options.setOptionActive` 의 한 문장 가드).
  공고 폼의 세 칸은 선택 사항이라(비우면 NULL) 목록이 비어도 저장은 되지만, 고를 것이 없는 칸이 되지 않게 막는다.
- **사용 종료된 항목:** 새 공고 작성 폼과 공개 검색 칸에서만 빠진다. 그 값을 가진 공고는 목록·상세·홈·기업·관리자 화면에 이름이 그대로 보인다(`labelOf`).
  기존 공고를 고칠 때는 저장된 값이 사용 종료여도 "(사용 종료)" 표시로 목록에 있고 그대로 저장된다(`selectableCodes`). 다른 사용 종료 값으로 바꾸는 요청은 `validateJob` 이 거부한다
  (화면 목록과 서버 검사 목록이 같은 `selectableAll` 결과). 검색 주소의 사용 종료·없는 값은 모르는 값처럼 버려지고 정규화 302 에서 빠진다.
- **이름 변경:** 이름은 공고에 복사하지 않으므로 고치면 기존 공고의 표시도 바뀐다. 관리자가 입력한 이름은 믿을 수 없는 글로 보고 JSX 로만 출력하며,
  한 줄·40자·금지 표현(`rules.findBannedPhrases`) 검사를 한다.
- **읽기:** 이름이 필요한 화면은 요청마다 `listOptions` 한 번(약 50행)으로 전체를 읽는다. 메모리 전역 캐시는 두지 않는다.
  `/jobs` 는 설정 한 행과 항목 목록을 동시에 읽은 뒤 정규화 302 를 판단한다(공고는 읽지 않는다). 비로그인 캐시 hit 은 D1 을 읽지 않는다.
  → 항목을 바꾸면 비로그인 방문자에게는 **최대 60초** 예전 화면이 보일 수 있다 (9절과 같은 TTL). 로그인한 사용자는 바로 바뀐다.
- **사용 공고 수:** 관리자 화면의 숫자는 상태와 관계없이 그 code 를 가진 모든 공고 수다(`countOptionUsage`, 세 컬럼에 인덱스가 없어 jobs 전체를 읽는다. 관리자 화면에서만).
- 고정 목록은 그대로 코드에 있다: 중국어 수준·진출 단계·퇴직금 기준·보고 라인 (값이 규칙·CHECK 제약과 묶여 있다).

## 11. 지원 (T-08)

- **누가:** 구직자 본인만. 지원은 구직자가 2단계 화면에서 "지원하기" 를 눌렀을 때만 생긴다. 운영자·시스템이 이력서를 고르거나, 대신 내거나, 기업에 보내는 길은 없다 (CLAUDE.md 규칙 1).
  기업 쪽 지원자 목록·열람은 T-09 이다. 화면 문구에는 "운영자는 지원서를 검토·추천·전달하지 않는다" 를 적는다.
- **흐름 (`routes/applications.tsx`):** 공고 상세의 "지원하기" → `/jobs/:id/apply` 1단계 이력서 고르기(대표 기본 선택, `resumeReadyToApply` 가 아니면 고를 수 없음)
  → 2단계(같은 주소 `?resume=`) 이번 지원에만 쓸 항목 수정 + 첨부 "함께 보내기" + 확인 상자 + 국외 이전 동의 칸 → POST.
  고친 내용은 지원서(복사본)에만 들어가고 저장된 이력서는 바뀌지 않는다. 이 화면에서는 새 파일을 올리지 않는다.
- **제출 순서:** 공고(공개 여부, `isPubliclyVisible`) · 내 이력서 → 항목 검사(`validateResume`, 이름표는 이력서의 것을 넣어 검사만) → 동의 필요 여부
  → 미리 `applyBlocks`(복사가 된다고 보고, 막히면 R2 에 쓰지 않음) → 첨부 복사(`copyResumeFile`: 풀어서 새 키로 다시 암호화한 지원서 전용 객체)
  → 실제 복사 결과로 `buildSnapshot` · `applyBlocks` 다시 → `sealResume` → `insertApplication`(한 문장 안에서 공개 조건 `publicJobWhere`·중복을 다시 확인, 동의가 있으면 같은 트랜잭션에서 `consents`)
  → 성공한 뒤에만 기업 알림. 막히거나 저장이 거절·실패하면 방금 복사한 객체를 지운다.
  첨부 복사가 실패하면 첨부 없이 내고(결과 화면에 알림), 첨부가 빠져서 지원할 수 없게 되면(경력 요약 없음) 내지 않고 알린다.
- **한 공고에 한 번:** `UNIQUE (job_id, seeker_id)` + `insertApplication` 의 `NOT EXISTS`. 취소한 지원도 행이 남으므로 **같은 공고에 다시 지원할 수 없다** (`applyBlocks` → `already_applied`, 화면은 기존 지원으로 보낸다).
- **국외 이전 동의 (`lib/application.consentNeed`, 지원할 때의 담당자 구성으로 정한다):**
  본사 소속(`is_hq = 1`) 담당자가 없으면 칸이 없고 체크값이 와도 저장하지 않는다. 본사 + 한국 담당자가 있으면 **선택**(기본 해제, 해제하면 한국 담당자만 열람 — `authz.canViewApplication`).
  본사 담당자만 있으면 **필수**(없으면 아무도 볼 수 없으므로 제출 불가). 동의하면 `applications.cross_border_consent_at` 과 `consents(type='cross_border', version=CROSS_BORDER_VERSION, ref_id=지원 id)`.
  문구는 locales `apply.consent.*` 의 초안이고 판(版)은 화면에 보이지 않는다. 확정은 T-11.
  알려진 점: 지원한 뒤 기업이 본사 담당자를 추가해도 예전 지원에는 동의가 없으므로 그 담당자는 볼 수 없다(설계대로).
- **기업 알림:** 그 기업의 활성 담당자(`users.status = 'active'`) 최대 10명에게 `new_applicant` 메일(`newApplicantMail`: 공고 제목과 `/biz` 주소, 한국어+중국어). 구직자 정보는 넣지 않는다.
  실패해도 지원은 그대로이고 구직자에게 오류로 보이지 않는다. 콘솔에는 `apply: notify failed` 같은 일반 문구만.
- **지원 현황:** `/my/applications` 목록, `/my/applications/:id` 한 건(기업이 보는 복사본 그대로, 동의 여부, 첨부 내려받기 = `serveApplicationFile` → access_log).
  구직자가 자기 지원서 화면을 보는 것은 access_log 에 남기지 않는다(이력서 화면과 같다). 상태 이름은 구직자용 문구(`app.status.*`).
- **취소:** 확인 화면 → POST. `canWithdraw`(진행 중인 상태만) → `withdrawApplication`(`application_events` 에 `withdrawn` + 상태 `nextStatus(…, 'withdrawn')` + `resume_snapshot = ''`·`file_r2_key = NULL`·`purge_after` + 동의 `withdrawn_at`, 한 트랜잭션)
  → 그 뒤 R2 객체 삭제(실패하면 고아 객체 → T-12). 취소된 지원은 본인 말고 아무도 볼 수 없다(authz). 이 작업에서 상태를 바꾸는 길은 취소 하나뿐이다 (CLAUDE.md 규칙 3).
- **캐시:** `/jobs/:id/apply` 와 `/my/applications*` 는 모두 `private, no-store` 이고 page-cache 를 거치지 않는다.

