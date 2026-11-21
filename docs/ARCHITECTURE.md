# 아키텍처

기획서·기술설계서(Claude 문서 "중국기업 한국진출 채용정보 서비스 기획서")의 결정을 코드 구조로 옮긴 문서다.
코드와 이 문서가 다르면 이 문서를 먼저 고치고 운영자 확인을 받는다.

## 1. 한 장 요약

- **무엇:** 한국에 진출한 중국기업의 채용 공고와 기업 정보를 보여주는 사이트. 기업은 중국어로 공고를 쓰고, 구직자는 한국어로 본다.
- **법적 형태:** 직업정보제공사업. 직업소개(알선)는 하지 않는다. 구직자와 기업은 직접 연결된다.
- **구성:** Cloudflare Worker 하나(Hono). 화면은 서버 렌더링, DB 는 D1, 파일은 R2, 메일은 Resend, 번역은 Claude API.
- **환경:** dev(로컬) → test(recruit.kimbbob.xyz, 가짜 데이터) → production(kimbbob.com, 신고 후).

```
브라우저(한국·중국) ──▶ Cloudflare Worker (src/index.tsx)
                          ├─ 정적 파일 public/
                          ├─ D1  (migrations/)
                          ├─ R2  (이력서 파일·검증 서류, 비공개)
                          └─ 외부 API: Resend · Claude · 국세청 사업자 상태조회   ← Worker 에서만 호출
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
  locales/ko.ts zh.ts  화면 문구
  routes/            화면·API 라우트 (기능별 파일)
  views/             JSX 화면 조각
migrations/          D1 스키마 (번호 순서, 기존 파일 수정 금지)
public/              정적 파일 (app.css). 외부 폰트·스크립트 없음
test/                vitest. rules·authz·crypto 는 반드시 테스트한다
docs/                이 문서, API.md, TASKS.md
```

★ 표시 두 파일이 이 서비스의 안전장치다. 라우트는 판단을 직접 하지 않고 이 두 파일의 함수를 호출한다.

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
- 비밀값(`ENC_KEY`, `SESSION_PEPPER`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`)은 `wrangler secret put` 으로 환경마다 따로 넣는다.
- `ENC_KEY` 를 잃으면 이력서와 백업을 복구할 수 없다. 운영자는 오프라인 사본을 보관한다.
- 무료 플랜 한도: Workers 요청 10만/일·CPU 10ms/요청, D1 읽기 500만 행/일·쓰기 10만 행/일. 실제 이력서를 받는 시점부터는 유료 플랜(월 5달러)을 권장한다.

## 7. 아직 정해지지 않은 것

- 1350 답변에 따라 바뀌는 것: 헤드헌터 공고, 이력서 중국어 요약, 통역 서비스, 한국법인 없는 본사의 검증 서류(营业执照).
- 브랜드명: 화면의 `Recruit` 는 임시다 (`src/locales/` 의 `site.name`).
- Cloudflare Turnstile(봇 방지): 중국 접속 테스트 뒤 결정. 지금은 발송 횟수 제한만 있다.
