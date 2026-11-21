# 할 일 목록

위에서부터 순서대로 한다. 한 번에 하나. 끝나면 `[x]` 로 바꾸고 `npm run typecheck && npm test` 통과를 확인한다.
규칙은 CLAUDE.md, 설계는 docs/ARCHITECTURE.md, 경로는 docs/API.md.

## 완료
- [x] T-00 저장소 뼈대, 스키마, 규칙(rules)·권한(authz)·암호화(crypto), 테스트 25개
- [x] T-01 이메일 인증코드 로그인·세션·로그아웃·언어 전환 (로컬에서 동작 확인)
- [x] T-02 공통 정리: 역할별 `/my` 분기(구직자 → 지원 현황, 기업 → /biz, 관리자 → /admin), 404·403 화면 문구, `loadActor()`
      (users + company_members + agency_members 를 읽어 `authz.Actor` 를 만드는 함수) 추가
- [x] T-03 관리자 2단계 인증(TOTP): 이메일 인증코드 통과 후 TOTP 를 통과해야 세션 발급, 최초 로그인 때 인증 앱 등록,
      TOTP 를 통과한 세션(`sessions.mfa = 1`)만 관리자로 인정, `/admin` 첫 화면(처리할 일 개수). 관리자 계정 만드는 법은 README
- [x] T-04 기업: 기업 등록(대표 담당자 자동 지정, 1차는 한 사람이 기업 하나), 기업 정보 편집(검증 뒤 기업명·사업자 형태·번호 잠금,
      반려된 기업이 신원 항목을 고치거나 서류를 올리면 다시 검증 대기), 검증 서류 업로드(R2 비공개, PDF·JPG·PNG 내용 검사, 10MB, 기업당 5개),
      담당자 초대(`company_invites`, `is_hq` 선택, 메일 없이 로그인 후 수락, 담당자+대기 초대 10명), 관리자 승인·반려(`verifyBlocks` 가 비어야 승인,
      반려 사유 필수), 공개 기업 목록·상세("기업 제공 정보" 표시). 국세청 상태조회는 키가 없어 관리자 수동 확인
- [x] T-04b 기업 검증 보완: 관리자의 승인 취소(사유 필수, 기업은 반려 상태가 되고 그 기업의 게재 중 공고는 `closed`, 공개 목록에서 빠짐,
      기업이 고치거나 서류를 새로 올리면 다시 검증 대기), 반려·승인 취소 때 "서류에 문제가 있음" 을 체크하면 서류도 `rejected`
      (새 서류를 올려야 다시 승인 가능), 담당자 초대 메일 발송(`company_invite`, 기업 이름·로그인 주소만, 한국어+중국어, 실패해도 초대는 유지,
      검증 완료 기업만 발송 — 미검증 기업명이 담긴 메일을 임의 주소로 보내는 통로를 막기 위함).
      국세청 상태조회는 T-04c 로 분리
- [x] T-05 공고 작성·현지화·게재: 기업 공고 목록·작성·편집(`/biz/jobs`). 중국어 원문은 제목(`title_zh`, 0005 에서 추가)과 본문(`source_zh`)으로 나눠 저장하고,
      직무·업계·근무지·중국어 수준·보고 라인은 선택형, 연봉(만원/년, 퇴직금 기준 필수)·근무시간(시작·종료)·마감일은 숫자·날짜 입력(번역하지 않음).
      원문에 이메일·전화번호가 있으면 저장을 거부(엔진에 연락처가 가지 않게). 현지화 엔진 층(`src/lib/localize/`: claude·gemini·workers_ai,
      `LOCALIZE_ENGINE` 으로 우선 엔진 지정, 실패 시 다음 엔진, 엔진당 1회·25초 제한, 같은 공고 20초 간격 제한)으로 한국어 초안 + 별도 호출로 중국어 대조본(`back_zh`).
      엔진이 없거나 모두 실패하면 수동 입력(대조본 없음 안내). 기업이 한국어를 직접 고치면 대조본을 지운다. 원문 | 한국어 | 대조본 3열 확인 화면,
      숫자 대조 경고(게재 조건 아님), 승인 → `publishBlocks()` 가 빈 배열일 때만 게재(WHERE 에서 상태·rev·승인·검토·기업 검증 재확인), 마감.
      원문·한국어를 고치면 `localize_status` 는 review, 게재 중이면 게재 중단(`planJobSave`). 조건만 고친 게재 중 공고는 바뀐 값으로도 `publishBlocks` 가 비어야 유지.
      저장할 때마다 `techLeakFlag()` → `review_flag`, 걸린 글이 바뀌면 `review_cleared_by` 해제. 관리자: 검토 대기·차단 공고 목록·상세(`/admin/jobs`),
      검토 통과(본 rev 일 때만)·차단(사유 필수, `block_reason`)·차단 해제(→ 미게재), 엔진 비교 화면(`/admin/localize-test`, 저장 안 함).
      `translations` 캐시는 쓰지 않음(결과는 공고 행에 저장되고 "다시 만들기" 는 새 결과가 필요). 세 엔진 어댑터는 실제 API 로 호출해 보지 않았다(키 없음) — T-05b
- [x] T-05d DB 접근 계층 정리(동작 변경 없음): 라우트·lib 에 흩어져 있던 SQL 78개 문장과 D1 호출(`prepare`·`batch`·`meta.changes`)을
      `src/db/`(users · sessions · companies · jobs · logs · admin)의 이름 붙은 함수로 옮겼다(SQL 문자열·바인딩 순서·batch 안 문장 순서·가드 그대로,
      `src/routes/job-db.ts` 는 `src/db/jobs.ts` 로 흡수). SQLite 전용 부분에 `[sqlite]` 주석, PostgreSQL 이전 안내 `docs/DB-PORTING.md`,
      경계 검사 테스트 `test/db-layer.test.ts`(src/db 밖에서 `.prepare(`·`.batch(`·`meta.changes`·SQL 문자열·`env.DB` 직접 사용 금지)

- [x] T-06 공개 공고 목록·상세(`/jobs`, `/jobs/:id`)와 홈의 최신 공고 5건. 공개 조건은 하나(`lib/public-jobs.isPubliclyVisible` = `db/public-jobs.publicJobWhere`,
      SQLite 메모리 DB 에서 두 쪽이 같은지 테스트): 게재 중 + 기업 검증 완료 + 헤드헌터 공고 아님 + 사무직(생산직은 `FLAG_PRODUCTION_JOBS`) + 마감 전.
      보이지 않는 공고는 보통의 404. 공개 컬럼만 읽고(원문·대조본·검토·차단 사유·엔진 없음), 기업명 비공개 공고는 SQL 에서부터 이름·id 를 NULL 로.
      필터 7개(중국어 수준·직무·업계·진출 단계·퇴직금 기준·보고 라인·근무지, 기존 선택 목록 재사용, 모르는 값은 무시, 바인딩만),
      20건씩 최신 게재 순(`published_at DESC, id DESC`), 한 행 더 읽어 다음 페이지 판단(COUNT 없음), 100페이지 상한. 폼의 빈 칸·모르는 조건은
      정규화 주소로 302. 상세는 구조 항목(연봉·퇴직금 기준·보고 라인을 위에 크게), 기업 블록, 기업 연락처(mailto) + "사이트 지원 기능 준비 중" 안내(지원 버튼 없음).
      중국어 화면은 문구만 중국어, 공고 글은 한국어. 비로그인 요청은 Workers Cache API 로 60초 캐시(키 = 경로 + 이름순으로 정렬한 검색 조건 + 판별된 언어,
      `Vary: Cookie, Accept-Language`), 로그인 쿠키가 있으면 캐시를 거치지 않고 `private, no-store`. 언어 전환 링크가 검색 조건을 유지하도록 render 수정.
      목록 질의는 기존 `idx_jobs_status(status, job_family, published_at)` 를 순서대로 읽어 새 인덱스는 추가하지 않음(마이그레이션 없음).
      wrangler dev + Chromium(Playwright)으로 필터·페이지·상세·언어 전환·로그인/로그아웃 머리글·캐시 hit/miss 확인
- [x] T-06d 공개 필터 표시 설정: `site_settings`(0006, key/value, `updated_by`·`updated_at`)와 `db/settings.ts`(getSetting·setSetting upsert).
      `public_job_filters` = `/jobs` 에 보일 필터의 JSON 배열(`lib/public-jobs.parseEnabledFilters`: 없으면 중국어 수준·보고 라인·근무지, 잘못된 값은 기본값,
      모르는 이름은 버림, 빈 배열 = 검색 칸 없음, 표시는 `FILTER_KEYS` 순서). 숨긴 필터는 모르는 조건과 같게 처리(`parseJobFilter`·`canonicalJobsHref` 에 목록을 넘김:
      걸러지지 않음, 개수에 안 듦, 정규화 302 에서 빠짐). 목록 줄·상세·공고 작성 폼·홈은 그대로. 관리자 `/admin/settings`(체크박스, 모르는 값 버림, 관리자 첫 화면에 링크).
      `/jobs` 는 캐시에 없는 요청마다 설정 한 행을 읽음(따로 캐시하지 않음) → 비로그인 화면 반영은 최대 60초(page-cache TTL).
      기존 테스트 "정규화 302 는 DB 를 읽지 않는다" 는 "설정 한 행만 읽고 공고는 읽지 않는다" 로 바꿈
## 운영자 설정 (사람이 하는 일 — 안내 문서를 먼저 써서 건넨다)
- [ ] O-1 GitHub 저장소에 이 폴더 올리기
- [ ] O-2 Cloudflare: D1 `recruit-test` 생성 → `wrangler.jsonc` 의 `database_id` 교체, R2 `recruit-test-files` 생성
- [ ] O-3 비밀값 넣기: `wrangler secret put ENC_KEY` · `SESSION_PEPPER` (ENC_KEY 는 오프라인 사본 보관)
- [ ] O-4 `npm run db:remote` → `npm run deploy` → 사용자 지정 도메인 recruit.kimbbob.xyz 연결
- [ ] O-5 Cloudflare Access 로 recruit.kimbbob.xyz 를 운영자만 접속하게 잠그기
- [ ] O-6 (나중) Resend 키, 현지화 엔진 키(Anthropic 또는 Gemini, 또는 Workers AI 바인딩 켜기 — README "현지화 엔진"), 공공데이터포털 국세청 사업자 상태조회 키 발급
- [ ] O-7 (나중) 고용노동부 1350 문의 → 답에 따라 기능 플래그 결정

## 개발
- [ ] T-05b 현지화 엔진 실호출 확인 (운영자가 키를 넣은 뒤): `/admin/localize-test` 로 claude·gemini·workers_ai 각각 호출해
      응답 모양·소요 시간(25초 안인지)·JSON 준수·숫자 보존을 확인하고, 기본 모델(`DEFAULT_*_MODEL`)이 맞는지 정한다.
      Gemini `thinkingLevel`, Workers AI 모델의 출력 모양(`choices` / `response`)과 `max_tokens` 인식 여부, Claude `anthropic-version` 을 새 버전(2026-10-21)으로 올릴지 함께 본다
- [ ] T-05c 공고 남용 방지: 기업당 초안 개수 한도, 기업당 하루 현지화 호출 한도(지금은 같은 공고 20초 간격만 있다)
- [ ] T-06b 디자인 패스: 공고 목록·상세·로그인 화면이 생긴 뒤 한 번에 한다. 밝은 톤, 사무직·전문직 대상의 차분한 인상.
      Claude Code 에서 unslop 스킬(https://github.com/heydamir/unslop, CC BY 4.0)을 쓸 수 있다. 단 이 프로젝트 제약이 우선한다:
      외부 폰트·CDN·외부 스크립트 금지, 유료 이미지 생성 금지, 이모지 라벨·보라색 그라데이션·글로우 금지, 색 강조는 한두 곳만,
      한국어·중국어 화면 모두 확인. 스킬은 제3자 지침이므로 설치 전에 운영자가 내용을 확인한다
- [ ] T-06c 공개 화면 보완: 생산직 플래그를 켤 때 목록 질의 계획 다시 확인(`job_family IN (...)` 이면 정렬용 임시 B-tree 가 전체 게재 공고를 읽을 수 있음),
      공고가 수천 건을 넘으면 필터별 인덱스 필요 여부 확인(D1 대시보드의 rows read), 캐시를 우회하는 임의 검색 조건(홈 `/?x=`) 처리,
      마감·차단 직후 캐시 즉시 지우기(지금은 최대 60초 남음 — 배포 환경의 Cache API purge 는 zone 단위라 확인 필요)
- [ ] T-07 이력서: 여러 개 저장(최대 5개)·이름 붙이기·대표 이력서 지정(처음 만든 것이 자동으로 대표, 대표를 지우면 가장 최근 것이 대표),
      간단한 폼(필수 5개 + 선택 항목 + 첨부파일 1개, ARCHITECTURE 4장), 전체 암호화 저장, 본인 열람·수정·복사·삭제.
      첨부파일은 확장자·크기 검사 후 R2 비공개 저장, 내려받기는 권한 확인 후에만
- [ ] T-08 지원: 이력서 선택(기본값 대표 이력서) → 이번 지원에만 적용할 수정(원본은 그대로) → 지원 확인 화면(받는 곳 표시, 본사 담당자가 있는 기업이면 국외 이전 동의 체크) → `resume_snapshot` 저장
      → 기업 담당자에게 "새 지원자" 메일(개인정보 없이 링크만). 지원 현황, 지원 취소
- [ ] T-09 지원자 관리: 목록, 지원서 열람(`viewed` + access_log), 면접 요청 메일(중국어 입력 → 한국어 변환, 답장 주소는 기업 담당자),
      불합격 일괄 통보, 관리자 사유 입력 열람, 열람 기록 화면
- [ ] T-10 조건 알림: 필터 저장, 일간·주간 메일(제목 "조건에 맞는 새 공고"). 무료 플랜 CPU 한도를 넘지 않게 한 번에 보내는 수를 제한
- [ ] T-11 약관·개인정보처리방침·국외 이전 동의 문구 화면 (초안 작성 → 운영자 확인), `consents` 기록, 회원 탈퇴(즉시 삭제)
- [ ] T-04c 국세청 사업자 상태조회 (공공데이터포털 키 발급 후)
- [ ] T-12 예약 작업: 공고 자동 마감(마감일 또는 30일 무수정, 3일 전 안내), 미처리 지원자 `auto_closed`, `purge_after` 지난 지원서 삭제,
      만료 세션·인증코드 정리, 사용량 점검 메일
- [ ] T-13 운영 환경: `wrangler.jsonc` 에 `env.production`(별도 D1·R2·도메인), 주 1회 암호화 백업, 배포 절차 문서
- [ ] T-14 (플래그 뒤) 이력서 중국어 요약: 경력·기술 항목만 번역 → 구직자 승인(`summary_approved_at`) → 기업 화면에 원문과 나란히 표시,
      본사 공유(받는 사람은 이메일 인증코드로 확인, 7일 만료) → `summary_shared`
- [ ] T-15 (플래그 뒤) 헤드헌터: 업체 등록·검증, 공고 등록 시 실제 구인 기업 지정, 지원 화면에 받는 곳 표시

## 2차 (지금 만들지 않는다)
소셜·QR 로그인(카카오 → 위챗 순. `user_identities(user_id, provider, provider_uid)` 테이블을 추가해 이메일 계정에 연결한다. Google 은 중국에서 차단되므로 넣지 않는다),
플랫폼 내 번역 메시지, 면접 일정, 구직자 공개 프로필·인재 검색, 카카오·위챗 로그인과 알림, 결제(PG), 응답률 공개, 채용 브랜딩 페이지
