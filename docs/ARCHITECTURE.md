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
    page-cache.ts    공개 화면 캐시 (비로그인만, 60초) (9절)
    localize/        현지화 엔진 층 (7절)
  db/                SQL 과 D1 호출은 여기에만 (T-05d). users · sessions(인증코드·세션·TOTP 대기) · companies(기업·담당자·초대·서류 행)
                     · jobs · public-jobs(공개 공고 읽기) · logs(access_log·email_log) · admin(개수). 판단은 하지 않고 받은 값으로 SQL 만 실행한다.
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
  선택: phone · desired_role(희망 직무) · experience_text(경력 요약, 자유 서술 1칸) · 첨부파일 1개(PDF·DOCX, 10MB, R2 비공개)
  ```
  `resumes.body` 에는 위 항목을 JSON 으로 묶어 암호화해 저장하고, 첨부파일은 `file_r2_key` 로 가리킨다.
  첨부파일 또는 experience_text 중 하나는 있어야 지원할 수 있다.
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
- **연락:** 상세에는 기업이 입력한 연락처(mailto)와 "사이트 지원 기능은 준비 중, 기업에 직접 연락할 수 있음" 안내만 둔다. 지원 버튼은 T-08.
- **캐시 (`lib/page-cache.ts`):** `/`, `/jobs`, `/jobs/:id` 의 **로그인 쿠키(sid)가 없는** GET 만 Workers Cache API(`caches.default`)에 **60초** 저장한다.
  - 키 = 경로 + 이름순으로 정렬한 검색 조건 + 판별된 언어(`?lang=` → `lang` 쿠키 → Accept-Language). 같은 주소도 언어마다 따로 저장된다.
  - 응답 머리글 `Cache-Control: public, max-age=60`, `Vary: Cookie, Accept-Language` (브라우저가 언어 쿠키·로그인 쿠키가 바뀐 뒤 저장해 둔 화면을 다시 쓰지 않게).
    200 이고 Set-Cookie 가 없는 응답만 저장한다. 404·302 는 `private, no-store`.
  - 로그인 쿠키가 있으면(만료된 쿠키라도) 캐시를 읽지도 쓰지도 않고 `private, no-store` (머리글에 계정 메뉴가 나오므로).
  - 필터 폼은 빈 칸도 보내므로 `/jobs` 는 정규화 주소(`jobsHref`)가 아니면 302 로 보내 같은 조건이 한 캐시 항목을 쓰게 한다.
  - **알려진 한계:** 마감·차단·게재 중단·기업 승인 취소된 공고도 **최대 60초** 캐시에서 보일 수 있다 (마감일이 지난 공고도 마찬가지).
    그래서 TTL 을 짧게 둔다. 배포 직후에도 이전 화면이 최대 60초 보일 수 있다. Cache API 는 데이터센터별이라 지역마다 따로 채워진다.
  - `X-Page-Cache: hit | miss | bypass` 머리글로 확인할 수 있다.
- **페이지:** 20건씩, `published_at DESC, id DESC`. 전체 개수를 세지 않고 21건을 읽어 다음 페이지 여부만 안다. 100페이지(2,000건) 넘게는 줄인다.
- **인덱스:** 기본 목록(생산직 플래그 꺼짐)은 기존 `idx_jobs_status(status, job_family, published_at)` 를 최신 순으로 읽고 LIMIT 에서 멈춘다
  (같은 게재 시각 안에서만 id 로 정렬). 필터는 이 순서로 읽으며 조건을 확인한다. 공고가 많아지면 T-06c 에서 다시 본다.
