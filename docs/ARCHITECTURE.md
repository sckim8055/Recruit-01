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
    applicants.ts    본인 아닌 사람이 지원서·첨부를 여는 유일한 길 openApplication · downloadApplicationFile (12절)
    consent.ts       이용약관·개인정보 필수 동의 판단(판, 빠진 동의, 예외 주소, 돌아갈 주소) — 순수 함수 (13절)
    account.ts       회원 탈퇴: 막는 경우 판단 → 파일 키 모으기 → DB 지우기 → R2 지우기 (13절)
    static-files.ts  public/ 의 파일 주소 (동의 확인에서 건너뜀)
    quota.ts         남용 방지 한도: 한도 숫자(한 곳)·변수 해석·한국 시간 날짜·기업 몫 → 사이트 몫 잡기 (15절)
    localize/        현지화 엔진 층 (7절)
  db/                SQL 과 D1 호출은 여기에만 (T-05d). users · sessions(인증코드·세션·TOTP 대기) · companies(기업·담당자·초대·서류 행)
                     · jobs · public-jobs(공개 공고 읽기) · logs(access_log·email_log) · admin(개수) · settings(site_settings) · options(job_options) · resumes(이력서)
                     · applications(지원·동의·취소) · application-views(지원 현황 화면용 읽기) · applicants(기업·관리자 쪽: 내용 없는 지원자 목록·개수·지원 한 건·viewed·열람 기록 읽기)
                     · consents(이용약관·개인정보 동의 읽기·쓰기) · account(탈퇴 트랜잭션) · usage(하루 사용량 한도, 15절). 판단은 하지 않고 받은 값으로 SQL 만 실행한다.
                     PostgreSQL 로 옮길 때 고칠 곳과 SQLite 전용 문법 목록은 docs/DB-PORTING.md
  legal/             이용약관(terms.ts)·개인정보처리방침(privacy.ts) 본문, 운영자 정보(types.ts OPERATOR). 한국어 기준 + 중국어 참고 번역 (13절)
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
- 관리자는 공고 내용을 고칠 수 없고 차단만 한다. 지원서는 사유를 입력해야 열리고 `access_log` 에 사유와 함께 남는다 (12절). 이력서 원본의 관리자 열람 화면은 아직 없다.

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
    교체·삭제된 예전 객체는 DB 가 더 이상 가리키지 않게 된 **뒤에** 지운다. R2 삭제가 실패하면 어느 행도 가리키지 않는 객체가 남을 수 있다 → 14절 sweepOrphans 가 24시간 뒤 치운다.
  첨부파일 또는 experience_text 중 하나는 있어야 지원할 수 있다.
- 이력서 원본은 본인만 보고 고친다(`authz.canViewResume`·`canEditResume`). 기업·헤드헌터는 원본을 볼 수 없고 지원서(복사본)만 본다. 관리자 열람(사유 필요)은 함수만 있고 화면은 아직 없다.
- **번역 API 로 보내는 것은 headline·experience_text·desired_role·chinese_level·years 뿐이다.** 이름·연락처와 **첨부파일은 보내지 않는다**
  (파일 안에는 주민번호·주소·사진 같은 정보가 들어 있을 수 있다). 그래서 중국어 요약(`FLAG_RESUME_ZH_SUMMARY`)은 입력 항목만으로 만든다.
- **지원서(`applications.resume_snapshot`)** 는 지원 시점의 이력서 복사본이다. 지원 화면에서 이번 지원에만 쓸 내용으로 고쳐서 낼 수 있고, 이후 이력서를 고치거나 지워도 지원서는 바뀌지 않는다.
- **상태(`applications.status`)** 는 `application_events` 에서 `rules.nextStatus()` 로 계산해 저장한다.
- **`translations`** 는 공고 번역 캐시 전용이다. 개인정보를 넣지 않는다.
- **보관:** 지원서는 공고 마감(을 확인한 때) 후 180일(`purge_after`), 검증 서류 원본은 확인 후 1년, 열람 기록은 2년. 숫자는 `lib/retention.ts` 한 곳에 있고 개인정보처리방침 3항과 같아야 한다 — 지우는 작업은 14절(T-12).

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
- Cloudflare Turnstile(봇 방지): 중국 접속 테스트 뒤 결정. 지금은 발송 횟수 제한(로그인 코드 이메일당 60초)과 15절의 하루 한도만 있다.

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
  기업 쪽 지원자 목록·열람은 12절(T-09a). 화면 문구에는 "운영자는 지원서를 검토·추천·전달하지 않는다" 를 적는다.
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

## 12. 지원서 열람 (T-09a)

- **여는 길은 하나:** 본인 아닌 사람(기업 담당자·헤드헌터·관리자)이 지원서 내용을 얻는 길은 `lib/applicants.openApplication`, 첨부는 `lib/applicants.downloadApplicationFile` 뿐이다.
  라우트는 `db/applicants.getApplicationWithJob` 으로 읽은 행을 넘기고 돌려받은 내용만 그린다. 라우트에서 `resume_snapshot` 을 풀거나 권한을 다시 판단하지 않는다.
  `openApplication` 순서: 권한(`authz.canViewApplication`) → 관리자는 사유(`cleanReason`, 1~300자) → 복호화 → `access_log` 기록 → 기업·헤드헌터가 처음 열었으면 `viewed` 이벤트 + 상태(`rules.nextStatus`, `db/applicants.markViewed`).
  열 수 없는(손상된) 지원서·막힌 시도(남의 것·취소됨·국외 이전 동의 없음·사유 없음)는 기록하지 않는다. 기록에 실패하면 내용을 돌려주지 않는다.
- **무엇이 기록되나:** 지원서를 열 때마다, 첨부를 내려받을 때마다 `access_log` 한 줄(`target_type = 'application'`, 연 사람 id·역할·시각, 관리자는 사유).
  지원자 목록을 보는 것, 관리자 지원서 화면(개인정보 없는 정보 + 사유 폼)을 GET 하는 것은 기록하지 않는다 (내용이 나가지 않으므로).
  `viewed` 이벤트는 지원서마다 기업·헤드헌터가 처음 열 때 한 번뿐이다. 관리자 열람과 첨부 내려받기는 상태를 바꾸지 않는다. T-09a 에서 다른 상태 변경은 없다 (면접 요청·불합격 통보는 12-1, T-09b).
- **기업 화면:** 지원자 목록에는 개인정보가 없다(지원 순서 번호·지원일·상태·첨부 여부). 정렬·점수·추천 표시·메모·내보내기·전달·상태 변경 버튼이 없다 — 운영자·시스템은 지원자를 평가·추천·전달하지 않는다 (CLAUDE.md 규칙 1).
  기업 id 는 로그인 사용자의 소속에서만 정하고, 이 기업 공고의 지원서가 아니면 있는지 알리지 않고 404. 이 기업의 지원서이면 취소됨(삭제 안내)·국외 이전 동의 없음(본사 소속 담당자, 403 안내)·열 수 없음을 구분해 알린다.
- **우연한 열람 막기:** 지원서·첨부 화면은 요청 한 번에 `openApplication`(또는 `downloadApplicationFile`) 한 번만 부르고 캐시·미리 읽기를 하지 않는다.
  Hono 는 HEAD 를 GET 처리기로 돌리므로 HEAD 는 권한 검사보다 먼저 405, 브라우저의 미리 가져오기·미리 그리기(`Sec-Purpose`/`Purpose` 머리글)는 503 으로 거절한다 (`routes/guards.humanGetOnly`).
  모든 응답(로그인 리다이렉트·403 포함)이 `private, no-store`. 지원서 id 말고는 주소에 내용이 없고, 새 지원자 알림 메일에는 `/biz` 주소만 있다.
  메신저 링크 미리보기는 로그인 쿠키가 없어 로그인 화면으로 간다.
- **관리자:** 지원서 화면에는 개인정보 없는 정보와 사유 폼만 있고, 내용은 사유를 보낸 POST 의 응답에만 그린다(다시 GET 할 수 있는 주소에 내용이 없음). 첨부도 사유와 함께 POST.
  관리자 지원자 목록·사람 검색·수정·전달·일괄 내려받기는 없다. 관리자는 열람 기록(`/admin/access-log`)이나 신고에서 받은 지원 id 로만 닿는다.
- **구직자가 보는 것:** 자기 지원서 화면의 "열람 기록" — 본인 아닌 사람이 지원서·첨부를 연 시각과 역할(기업 채용 담당자·운영자)만. 이름·이메일·사유는 보이지 않는다 (`listViewsOfApplication`).
  상태는 처음 열람 때 "기업이 열람함" 으로 바뀐다. 취소한 지원에는 열람 기록 칸이 없다.
- **열람 기록 화면:** 최근 순 50건, 커서는 시각(`at < before`)뿐이다. 페이지 끝과 같은 초의 줄은 다음 페이지로 넘겨 빠지지 않게 하지만, 한 초에 51줄 이상이면 그 초의 일부가 빠질 수 있다(알려진 한계 — (at, id) 커서가 필요하면 `listAccessLog` 를 고친다).
- **알려진 점:** 지원 순서는 `created_at`(초) 다음 id 순이라, 같은 초에 들어온 지원끼리는 순서가 지원 순서와 다를 수 있다. 목록은 공고당 500건까지(`listJobApplications`).


### 12-1. 지원자에게 메일: 면접 요청·불합격 통보 (T-09b)

- **누가 보내나:** 그 공고 기업의 담당자(`canViewApplication` 이 허용하는 기업 담당자·헤드헌터)뿐이다. 본사 소속 담당자는 국외 이전에 동의한 지원에만 보낼 수 있다.
  **관리자·운영자가 지원자에게 메일을 보내는 경로는 없다** (규칙 1: 사이트는 채용 과정에 끼지 않고 글을 대신 쓰지 않는다). 판단·발송·기록은 `lib/applicant-mail.ts`
  (`sendInterviewRequest`·`sendRejection`) 만 하고, 화면(`routes/biz-applicants.tsx`)은 지원서를 풀지 않으며 받는 주소를 모른다.
- **순서:** 권한 → 상태(진행 중: 새 지원·열람함·검토 중·면접 요청함) → 횟수 → 복호화(연락 이메일) → 메일 발송 → `application_events`(`interview_mail`·`reject_mail`) + 상태(`nextStatus`, `db/applicants.recordMailEvent` 한 batch).
  **메일이 나간 뒤에만 기록한다** — 보내지 못하면 이벤트·상태 변화가 없다. 그사이 지원이 취소됐으면 메일은 나갔지만 기록되지 않았다고 알린다.
- **면접 요청:** 기업 담당자가 중국어 또는 한국어로 쓴 글(2000자) → 미리 보기에서 `localize/message.translateMessage`(엔진에는 메시지 글만) → 원문과 "한국어 자동 번역" 을 나란히 보이고
  담당자가 "번역 없이 원문만 보내기" 를 고를 수 있다. 메일에는 한국어 안내문 + 자동 번역(있으면, 원문 확인 안내와 함께) + 원문이 그대로 들어간다. 엔진이 없거나 실패하면 원문만 보낸다.
  답장 주소(Reply-To)는 보낸 담당자의 로그인 이메일이고 쓰기 화면에 그 주소가 지원자에게 보인다고 적는다. 한 지원에 **3번까지**(`INTERVIEW_MAIL_MAX`, 일정 변경용).
  예문·추천 답장·평가 문구는 없다. 원문·번역은 POST 본문(숨은 칸)으로만 오가며 주소·로그·`email_log`(템플릿 이름·결과·주소 해시뿐)·D1 에 남지 않는다.
- **불합격 통보:** 사유 칸 없이 **정해진 글**(locales `mail.reject.*`, 한국어)만 보낸다. 지원자 목록에서 진행 중인 지원을 골라(또는 지원서 화면에서 한 건) → 확인 화면(보낼 수, 보낼 글 그대로,
  되돌릴 수 없음·지원자 상태가 "불합격"·답장 주소 안내, 중국어 화면에는 같은 문구 키의 중국어 참고) → 한 번에 **10건까지**(`REJECT_BATCH_MAX`) 한 건씩 차례로 보낸다. 한 지원에 한 번(보내면 끝난 지원).
  다른 공고·다른 기업의 지원 id 가 섞이면 요청 전체를 404 로 거절한다.
- **열람과의 관계:** 쓰기·미리 보기·확인 화면은 지원서를 열지 않는다(개인정보 없음: 공고 제목·지원 순서 번호·지원일·상태). 보낸 뒤에는 지원자 목록으로 리다이렉트한다 — 지원서 화면으로 보내면 열람 기록이 하나 더 남기 때문이다.
  모든 응답은 `private, no-store`.
- **구직자 화면:** 상태가 "면접 요청 받음"·"불합격" 으로 바뀐다(`app.status.*`). 메시지 내용은 사이트에 남지 않으므로 메일로만 받는다.

## 13. 약관·개인정보 동의와 회원 탈퇴 (T-11)

- **문서:** `src/legal/terms.ts`·`privacy.ts`(한국어 기준, 중국어 참고 번역, `【확인 필요】` 표시는 운영자가 채운다), 화면 `/terms`·`/privacy`(누구나, 비로그인은 page-cache 60초, JSX 로만 출력, 주소는 글자 그대로).
  모든 화면 바닥글과 로그인 화면에서 연결한다. 본문을 고치면 `lib/consent.ts` 의 `TERMS_VERSION`·`PRIVACY_VERSION` 을 올린다 → 회원에게 다시 묻는다.
- **동의 확인 (`src/index.tsx`, 세션·언어 미들웨어 뒤, 라우트 앞):** 로그인한 회원 중 관리자가 아닌 사람(`needsConsentCheck`)은 요청마다 `db/consents.listRequiredConsents` 한 번(작은 색인 읽기,
  `idx_consents_user`)으로 지금 판의 `terms`·`privacy` 동의(철회되지 않은 것)를 확인한다(`missingConsents`). 따로 캐시하지 않는다.
  빠졌으면 GET·HEAD 는 `/consent?next=<원래 경로+검색 조건>`(`safeNext` 가 받는 경로일 때만, 아니면 `next` 없이)으로 302, 그 밖의 메서드는 403(처리하지 않음, 동의 화면 링크). 모두 `private, no-store`.
  - 확인하지 않는 것: **비로그인 요청**(아무것도 읽지 않는다 — 캐시되는 공개 화면이 D1 을 읽지 않게), 관리자, 예외 주소(`consentExempt`: `/consent` `/terms` `/privacy` `/logout` `/login*` `/lang/*` `/my/account*` `/api/health`),
    `public/` 의 파일(`lib/static-files.PUBLIC_FILES`; 배포 환경에서는 정적 파일이 Worker 앞에서 나가므로 원래 여기까지 오지 않는다).
  - 동의하지 않은 회원도 문서 읽기·언어 바꾸기·로그아웃·계정 화면·**탈퇴**는 할 수 있다 (거부한 사람이 나갈 수 있어야 한다).
- **동의 화면 `/consent`:** 비로그인 → `/login`, 관리자 → `/admin`, 빠진 것이 없으면 `safeNext(next)` 로. 빠진 종류의 체크 칸만 보이고(미리 체크하지 않음, 오류로 다시 그릴 때도),
  개인정보 칸에는 수집 항목·목적·보유 기간·국외 보관(Cloudflare·Resend, 방침 6항)을 요약한다. 지금 판에 이미 동의한 종류는 "이미 동의함" 으로만 보이고 폼 검사(`readConsentForm`)에서 체크된 것으로 본다.
  POST 는 빠진 종류만 `insertConsents`(같은 판의 유효한 동의가 있으면 건너뛴다) → 303 `safeNext(next)`. 하나라도 빠지면 400 + 아무것도 기록하지 않는다. **동의는 이 POST 에서만 기록한다.**
- **계정 `/my/account`:** 모든 로그인 회원(관리자 포함). 로그인 이메일·유형·동의 내역(종류별 판 — `listRequiredConsents` 가 동의 시각을 돌려주지 않아 시각은 보이지 않는다)·문서 링크·회원 탈퇴 입구.
  막히는 경우(`deletionBlocksFor`): 관리자(화면에서 탈퇴 불가), 다른 담당자가 있는 기업의 대표 담당자(먼저 담당자를 내보내거나 운영자에게 대표 변경 요청 — 대표를 넘기는 화면은 아직 없다).
- **탈퇴 `/my/account/delete`:** 확인 화면(무엇이 지워지고 남는지 + 로그인 이메일 입력) → POST `confirmMatches`(대소문자·앞뒤 공백 무시) → `deleteAccount` → 막히면 400 + 계정 화면,
  끝났으면(이미 탈퇴한 계정 포함) 로그아웃과 같은 `logout()` 으로 세션 쿠키를 지우고 303 `/?bye=1`. 홈은 `bye=1` 일 때만 한 줄 안내를 그리고, 이 요청은 page-cache 를 거치지 않는다
  (`routes/jobs.homeCache`, `private, no-store`) — 캐시되는 홈에는 안내가 들어가지 않는다. `/consent`·`/my/account*` 의 모든 응답은 `private, no-store`.
- **탈퇴 때 지워지는 것 (`db/account.eraseUser`, 한 트랜잭션):** 이력서 행, 지원서 내용(암호문 → `''`)·파일 키·`summary_zh`(진행 중이던 지원은 `withdrawn` 이벤트 + 상태 `withdrawn`, 끝난 지원은 상태 유지, `purge_after` = 탈퇴 시각),
  프로필, 알림 조건, 세션, 인증코드, 관리자 2단계 대기·비밀값, 기업·헤드헌터 소속, 받은(수락 전) 초대. 혼자 맡던 기업의 게재 중 공고는 `closed`.
  `users` 행은 지우지 않고 **이메일을 `deleted-<무작위>@deleted.invalid` 로 바꾸고** `status = 'deleted'` (같은 이메일로 다시 가입하면 새 계정, 동의도 새로 받는다).
  R2 파일(이력서·지원서 첨부)은 지우기 전에 키를 모아 두었다가 트랜잭션 뒤에 지운다(실패하면 고아 객체 → T-12, 콘솔에는 개수만).
- **남는 것:** 지원했다는 사실(행·상태·이벤트, 내용 없음), 동의 기록(`withdrawn_at` 을 채움), 열람 기록(`access_log`), 그 회원이 만든 공고와 기업 정보(기업의 자료), 기업이 낸 검증 서류.
  보관 기간은 개인정보처리방침 3항(동의 기록·지원 사실 2년은 【확인 필요】). 기간이 지난 행을 지우는 작업은 14절(T-12).


## 14. 예약 작업: 자동 마감·보관 기한 삭제·정리 (T-12)

코드: `src/lib/retention.ts`(기간 상수, 한 곳), `src/lib/maintenance.ts`(단계·시간표·상한·실행기), `src/db/maintenance.ts`(SQL), `src/index.tsx` 의 `scheduled`.
**이 작업은 데이터를 지운다.** 모든 UPDATE·DELETE 는 호출부가 넘긴 시각으로 거는 시간 조건 + 행 수 한도 + "아직 처리 전" 조건을 가지며, 두 번 실행해도 더 바뀌지 않는다.

### 14-1. 보관 기간 = 상수 = 개인정보처리방침 3항

| 대상 | 상수 (`lib/retention.ts`) | 방침 3항 (`src/legal/privacy.ts`) | 하는 단계 |
|---|---|---|---|
| 지원서 내용(복사본·첨부·요약) | `APPLICATION_KEEP_AFTER_CLOSE` = 180일 | "공고 마감 후 180일까지 보관한 뒤 삭제" (취소하면 바로 — T-08) | markApplications → purgeApplications |
| 진행 중 지원의 자동 종료 | `APPLICATION_AUTO_CLOSE_AFTER` = 30일 | (방침 항목 아님, 상태 "채용 종료") | markApplications |
| 사업자 서류 | `VDOC_KEEP_AFTER_REVIEW` = 365일 | "확인 후 1년" | purgeVerificationDocs |
| 열람 기록 `access_log` | `ACCESS_LOG_KEEP` = 730일 | "2년" | dropOldRows |
| 동의 기록(철회된 것)·지원했다는 사실(내용 없는 행·이벤트) | `ERASED_ROW_KEEP` = 730일 | "탈퇴 후에도 2년간 보관할 수 있습니다 【확인 필요: 기간】" | dropOldRows |
| 메일 발송 기록 `email_log`(주소 해시) | `EMAIL_LOG_KEEP` = 365일 | (방침에 따로 없음) | dropOldRows |
| 만료된 세션·인증코드·2단계 대기 | 만료 시각 | — | dropOldRows |
| 하루 사용량 `usage_counters`(id·날짜·횟수, 15절) | `lib/quota.USAGE_KEEP_DAYS` = 35일 | (개인정보 아님) | dropOldRows |
| 마감일 없는 공고 | `JOB_STALE_AFTER` = 30일, 안내 `JOB_CLOSE_NOTICE_BEFORE` = 3일 | — | closeJobs |
| R2 고아 객체 | `ORPHAN_MIN_AGE` = 24시간 | — | sweepOrphans |

`test/maintenance.test.ts` 가 상수로 만든 숫자("180일"·"1년"·"2년", 중국어 "180天"·"1年"·"2年")가 방침 3항 글(한·중)에 있는지 확인한다. 하나를 바꾸면 다른 쪽과 `PRIVACY_VERSION` 을 같이 바꾼다.

**"공고 마감 후 180일" 의 기준 시각:** 마감 시각을 따로 저장하지 않는다 (수동 마감 `db/jobs.closeJob` 은 시각을 찍지 않고, 그 문장의 가드는 바꾸지 않았다).
`markApplications` 가 공고가 `closed`·`blocked` 인 것을 **발견한 때** `purge_after = 그때 + 180일` 을 붙인다 → "마감 확인 후 180일" 이며 실제 마감보다 최대 한 주기(markApplications 사이 간격, 최대 8시간) 늦다.
자동 종료도 같은 기준이다: `purge_after - 180일 + 30일 < 지금` 이면 진행 중 지원에 `auto_closed`.
차단이 풀려 초안·게재 중으로 돌아간 공고(마감된 공고는 다시 열 수 없다 — 다시 여는 경로 없음)는, 기한이 아직 오지 않았고 내용이 남은 **진행 중** 지원의 `purge_after` 를 다시 NULL 로 한다(끝난 지원·기한이 지난 지원은 그대로).

### 14-2. 시간표와 상한

cron 은 **매시 정각 한 번**(`wrangler.jsonc` `"0 * * * *"`, `scheduledTime` 의 UTC 시각으로 단계를 고른다), 한 번에 **한 단계**만 한다 (`SCHEDULE`, 24칸).

| UTC | KST | 단계 | | UTC | KST | 단계 |
|---|---|---|---|---|---|---|
| 00 | 09 | report | | 12 | 21 | closeJobs |
| 01 | 10 | closeJobs | | 13 | 22 | markApplications |
| 02 | 11 | markApplications | | 14 | 23 | purgeApplications |
| 03 | 12 | purgeApplications | | 15 | 00 | purgeVerificationDocs |
| 04 | 13 | dropOldRows | | 16 | 01 | sweepOrphans |
| 05 | 14 | sweepOrphans | | 17 | 02 | closeJobs |
| 06 | 15 | purgeVerificationDocs | | 18 | 03 | markApplications |
| 07 | 16 | closeJobs | | 19 | 04 | purgeApplications |
| 08 | 17 | markApplications | | 20 | 05 | dropOldRows |
| 09 | 18 | purgeApplications | | 21 | 06 | sweepOrphans |
| 10 | 19 | dropOldRows | | 22 | 07 | closeJobs |
| 11 | 20 | sweepOrphans | | 23 | 08 | purgeApplications |

하루: closeJobs 5 · markApplications 4 · purgeApplications 5 · dropOldRows 3 · sweepOrphans 4 · purgeVerificationDocs 2 · report 1.
상한(`CAPS`, 한 번 실행): 공고 마감 10 · 안내 공고 10 · 안내 메일 10 · 지원 기한 붙이기/떼기/자동 종료 각 50 · 내용 삭제 10 · 표마다 행 삭제 200 · 서류 5 · R2 목록 100 · 고아 삭제 10 · 참조 확인 IN 50개.
→ 하루 처리량 최대: 공고 마감 50, 안내 메일 50, 지원 내용 삭제 50, 표마다 600행, 서류 10, 고아 40. 남은 것은 다음 차례에 이어서 한다 (기한보다 늦어질 수 있다 — 규모가 커지면 상한을 올리거나 유료 플랜).

**플랫폼 한도 (2026-11 Cloudflare 문서 확인):** Workers Free 는 cron 실행당 CPU 10ms, 실행당 하위 요청 50개(D1·R2 호출과 fetch 포함), cron 계정당 5개, cron 벽시계 15분.
D1 Free 는 실행당 쿼리 50개(문서상 `batch()` 는 한 번으로 센다), 문장당 바인딩 100개. 이 작업은 보수적으로 batch 안 문장도 하나씩 세어 **실행당 D1 문장 25개 이하, R2 호출 15개 이하**로 맞췄다
(계산상 단계별 최대: closeJobs 17(메일 10통 포함) · purgeApplications 15 · markApplications 13 · 나머지 10 이하, 집계 기록 2 포함. 테스트가 상한보다 많은 후보로 단계마다 25·15 이하인지 센다). CPU 10ms 는 테스트로 확인할 수 없다 — 배포 뒤 대시보드에서 확인한다.

### 14-3. 단계마다 하는 일 (src/db/maintenance.ts 의 문장 주석에 무엇을 지우는지 적혀 있다)

1. **closeJobs** — (a) 게재 중 + `closes_at <= 지금` → `closed`(updated_at = 지금). (b) 게재 중 + 마감일 없음 + `updated_at < 지금 - 30일` + **안내를 3일 전 이전에 보냄**(`close_notice_at <= 지금 - 3일`) → `closed`.
   (c) 안내: 게재 중 + `close_notice_at IS NULL` + (마감일이 (지금, 지금+3일] 안 또는 마감일 없음 + `updated_at < 지금 - 27일`) → 그 기업의 활성 담당자에게 `job_close_notice` 메일(한국어+중국어: 공고 제목·날짜·`/biz/jobs` 주소, 계속 게재하는 방법, 개인정보 없음)
   → 보낸 뒤 `close_notice_at = 지금` (읽을 때의 `updated_at` 이 그대로인 공고만). 기업이 저장하면(`updateJobSource`·`saveLocalized`·`saveKorean`) `close_notice_at = NULL`.
   담당자가 없는 공고는 메일 없이 안내 완료로 표시한다(그래야 (b) 가 진행된다). 초안·차단 공고는 건드리지 않고, **게재는 절대 하지 않는다.**
2. **markApplications** — 차단이 풀린 공고의 진행 중 지원 기한 떼기 → 마감·차단 공고의 지원(취소 제외, 기한 없음)에 `purge_after = 지금 + 180일` → 마감 확인 후 30일이 지난 진행 중 지원(`submitted`·`viewed`·`reviewing`·`interview` = `rules.nextStatus(s, 'auto_closed')` 가 바꾸는 상태)에 `auto_closed`.
   규칙 3: 상태별로 묶어 `nextStatus` 를 TypeScript 에서 계산하고, 한 batch 에서 이벤트(`auto_closed`, actor 없음)를 넣은 뒤 **그 지원에 방금 넣은 이벤트가 있을 때만** 상태를 바꾼다.
3. **purgeApplications** — `purge_after < 지금` 이고 내용·파일이 남은 지원 10건: **D1 먼저**(한 batch: 진행 중이면 `auto_closed` + 상태, `resume_snapshot = ''`·`file_r2_key = NULL`·`summary_zh = NULL`, 그 지원의 국외 이전 동의 `withdrawn_at`)
   → 아직 어떤 행이 그 키를 가리키는지 다시 확인 → 아무도 가리키지 않는 `rfiles/` 객체만 R2 에서 삭제. R2 삭제 실패는 세어 두고(행은 이미 지워짐) 고아 정리가 치운다. 공고 상태는 보지 않는다(기한이 지났으면 지운다).
4. **dropOldRows** — 표마다 200행, 자식 먼저, 한 batch: 내용이 지워진(`resume_snapshot = ''`·파일 키 없음) 지원 중 `purge_after < 지금 - 2년` 의 이벤트 → 이벤트가 남지 않은 그 지원 행,
   철회된 지 2년 지난 동의, 2년 지난 열람 기록, 1년 지난 메일 기록, 만료된 세션·인증코드·관리자 2단계 대기, 35일(한국 시간 날짜)보다 오래된 하루 사용량(T-05c).
   `company_invites` 와 `users` 는 건드리지 않는다. (batch 9문장 + 집계 2 = 11문장, 상한 25 안.)
   지원 행이 지워지면 그 공고에 같은 구직자가 다시 지원할 수 있게 된다(취소 후 2년 — UNIQUE 가 풀림).
5. **purgeVerificationDocs** — 확인(`approved`·`rejected`)이 1년 전에 끝난 서류 5건(`vdocs/` 키만): **행을 먼저**(행마다 한 문장) 지우고, 지워진 행의 `vdocs/` 객체만 R2 에서 지운다. 확인 대기(`pending`) 서류는 건드리지 않는다.
   서류가 모두 지워진 검증 완료 기업은 **검증 완료 그대로**다(검증 상태는 서류 행으로 다시 계산하지 않는다. `verifyBlocks` 의 "서류 없음" 은 검증 대기 기업의 승인 버튼에만 쓰인다 — 관리자 화면·공개 화면이 그대로 그려지는지 테스트).
   승인 취소 후 다시 승인받으려면 새 서류를 올려야 한다(지금도 같다). R2 삭제가 실패한 `vdocs/` 객체는 자동으로 치우지 않는다(남은 일).
6. **sweepOrphans** — R2 `rfiles/` 목록 한 쪽(100개, 커서 `site_settings` `maint.rfiles_cursor`, 목록이 끝나면 커서 삭제)에서 (a) 올라온 지 24시간 이상(`uploaded`) (b) `resumes.file_r2_key`·`applications.file_r2_key` 어디에도 없는(IN 50개씩 확인) 객체를 10개까지 지운다.
   참조 확인이 실패(예외)하면 하나도 지우지 않는다. 24시간이 안 된 객체(올리는 중·DB 쓰기 전)·다른 접두어는 건드리지 않는다. 지울 것이 10개를 넘거나 삭제가 실패하면 커서를 옮기지 않아 다음 차례에 같은 쪽을 다시 본다. 저장한 커서로 목록이 실패하면 커서를 지운다.
7. **report** — 00 UTC(09 KST) 한 번. `OPS_EMAIL`(선택 변수)이 있으면 전날(UTC) 단계별 처리 수 + 회원 수(역할별, 탈퇴 제외)·게재 중 공고 수·지원 수(상태별)를 평문으로 보낸다(개수만 — 이메일·이름·id 없음, 운영자용이라 한국어만). 없으면 메일 없이 넘어간다.
   단계별 처리 수는 실행마다 `site_settings` `maint.stats.<UTC 날짜>` 에 더해 두고(숫자만), 7일 지난 줄은 이 단계가 지운다.

### 14-4. 순서와 실패

- **DB 를 먼저, R2 를 나중에.** 반대로 하다 끊기면 DB 가 없는 파일을 가리키게 되고(지원서·이력서 화면 오류), 이 순서로 하다 끊기면 아무도 가리키지 않는 **암호문** 객체가 남을 뿐이다(rfiles/ 는 고아 정리가 24시간 뒤 치운다).
- 실행기(`runMaintenance`)는 단계를 try/catch 로 감싸고 예외를 밖으로 내보내지 않는다. 로그는 실행마다 한 줄 `maint: step=<이름> ok|failed counts=<숫자 JSON>` — 오류 내용·키·이메일·id 는 남기지 않는다.
  (dev·test 에서 Resend 키가 없으면 `lib/email.sendMail` 이 받는 주소와 본문을 콘솔에 출력한다 — 기존 동작, 운영에서는 출력하지 않는다.)
- 정리 작업을 실행하는 **HTTP 경로는 없다.** `scheduled` 만 실행한다. 개발용으로 cron 문자열 `maint:<단계>` 로 단계를 고르는 것은 `APP_ENV === 'dev'` 일 때만 받는다(배포 환경의 cron 문자열은 `wrangler.jsonc` 에 적은 `"0 * * * *"` 뿐이라 닿지 않는다. test 환경에서 같은 문자열을 보내도 시간표대로 실행됨을 확인).
- `users` 행은 이 작업에서 지우지 않는다: `jobs.created_by`·`access_log.actor_id`·`application_events.actor_id`·`consents.user_id` 등이 외래키로 가리킨다(D1 은 외래키를 검사한다). 탈퇴 계정은 이메일이 익명화된 상태로 남는다 → 남은 일.

## 15. 남용 방지 한도 (T-05c)

코드: `src/lib/quota.ts`(한도 숫자·변수 해석·날짜·몫 잡기, 한 곳), `src/db/usage.ts`(SQL), 마이그레이션 0010 `usage_counters`.
운영자가 비용을 내는 것(번역 API 호출·메일)과 누구나 만들 수 있는 것(공고 초안)에 단순하고 예측할 수 있는 한도를 둔다.

| 한도 (변수 = 기본값) | 무엇을 세나 | 어디서 잡나 | 걸리면 |
|---|---|---|---|
| `LOCALIZE_PER_COMPANY_DAY` = 30 / 기업·하루 | 자동 번역 호출. 공고 현지화·"다시 만들기"·면접 요청 번역 미리 보기가 **한 몫**을 같이 쓴다 | `POST /biz/jobs/:id/localize`(엔진 없음 검사·20초 간격 자리 잡기 뒤, 엔진 호출 전), `POST /biz/applications/:id/interview/preview`(엔진이 있을 때만, `translateMessage` 전) | 현지화: 400 + 안내, 한국어 직접 입력 칸은 그대로. 미리 보기: 번역 없이 원문만 + 안내(보내기는 막지 않음) |
| `LOCALIZE_SITE_DAY` = 500 / 사이트·하루 | 위 + 관리자 엔진 비교 | 위 두 곳 + `POST /admin/localize-test` (기업·관리자 몫 다음) | 위와 같음 |
| `ADMIN_LOCALIZE_TEST_DAY` = 50 / 관리자·하루 | 엔진 비교. 고른 엔진 하나마다 1 (cost = 엔진 수) | `POST /admin/localize-test` (입력 검사·엔진 선택 뒤) | 400 + 안내, 엔진을 부르지 않음 |
| `MAIL_PER_COMPANY_DAY` = 100 / 기업·하루 | 기업이 보내는 메일: 면접 요청·불합격 통보(한 통마다)·담당자 초대 | `…/interview/send`, `…/applicants/reject/send`(한 통마다), `POST /biz/members/invite`(검증된 기업이라 실제로 보낼 때만) — 모두 메일 핵심 함수를 부르기 **전** | 보내지 않음, 기록·상태 변화 없음. 면접: 400 + 글을 지닌 미리 보기. 불합격 묶음: 처음 걸린 곳에서 멈추고 `?limited=K&pool=` 로 보낸 수·못 보낸 수 안내. 초대: 초대는 저장, `?mail=limit_company\|limit_site` "직접 알려 주세요" |
| `MAIL_SITE_DAY` = 1000 / 사이트·하루 | 위 세 가지의 사이트 합계 | 위와 같음 (기업 몫 다음) | 위와 같음 |
| `DRAFT_JOBS_PER_COMPANY` = 20 / 기업 (개수) | 작성 중인 공고 = `status NOT IN ('published','closed')`(초안·차단), 헤드헌터 공고 제외 | `POST /biz/jobs/new` — `db/jobs.insertJob` 이 개수 확인과 추가를 한 문장으로 | 400 + 입력 유지 + 안내. 기존 초안은 고칠 수 있고, 게재·마감되면 한도에서 빠진다 |

- **세지 않는 것:** 로그인 인증코드 메일(로그인 흐름은 바꾸지 않았다 — 이메일당 60초 제한만), 새 지원자 알림 메일(구직자의 지원이 보내는 것), 예약 작업 메일(마감 안내·운영 보고).
- **하루:** 한국 시간(UTC+9) 날짜 `YYYY-MM-DD`(`kstDay`). 0시에 새 행으로 시작한다.
- **한 문장 가드:** `db/usage.takeQuota` = `INSERT … SELECT … WHERE cost <= limit ON CONFLICT DO UPDATE … WHERE n + cost <= limit`. 영향 행 1 이면 센 것. 동시에 들어와도 한도를 넘지 않는다(D1 은 쓰기를 차례로 한다).
- **순서:** 항상 기업(또는 관리자) 몫을 먼저, 그다음 사이트 몫. 기업 몫이 거절되면 사이트 몫은 건드리지 않는다. 사이트 몫이 거절되면 기업 몫에서 하나 쓴 것은 그대로 남는다(되돌리지 않는다 — 단순하게, 사이트 몫이 찬 날에만 생기는 일).
- **되돌리기 없음:** 몫을 잡은 뒤 엔진·메일이 실패하거나 핵심 함수가 다른 이유(끝난 지원 등)로 거절해도 한 번 쓴 것으로 센다. 실패를 일부러 일으켜 한도를 우회할 수 없게.
- **쓰지 않는 경우:** 엔진이 없으면(현지화는 `no_engine` 검사가 먼저, 미리 보기는 `availableEngines` 확인) 몫을 잡지 않는다. 검증 전 기업의 초대는 메일을 보내지 않으므로 잡지 않는다.
- **무게:** 한도가 걸린 동작마다 작은 문장 1~2개(기업 몫·사이트 몫)를 더한다. 초안 한도는 기존 INSERT 한 문장에 조건을 붙였다(문장 수 그대로).
- **보이는 곳:** 기업 화면에는 그 요청에서 한도에 걸렸을 때만 안내가 보인다(숫자는 `{n}` 으로 넣는다, 한국어·중국어). 관리자 첫 화면의 "오늘 사용량" 상자에 사이트 번역 호출·기업 메일 `쓴 수 / 한도`(읽기 두 번).
- **변수:** 같은 이름의 vars(`wrangler.jsonc` 에 빈 값으로 적어 둠). 앞뒤 공백을 뺀 0~1,000,000 의 정수만 받고, 비었거나 그 밖의 값은 기본값(`limitsOf`). 0 은 "그 기능을 쓰지 않음".
- **개인정보 없음:** `usage_counters` 의 subject 는 기업 id·관리자 user id·`'site'` 뿐(이메일·IP 없음). 35일 지난 행은 14절 dropOldRows 가 지운다.

