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
- [x] T-06b 디자인 정리 + 첫 화면 (동작·경로·권한·SQL·법정 문구 변경 없음). `public/app.css` 를 손으로 다시 씀(7,223 → 약 16.8KB, gzip 2.0 → 4.7KB):
      색·간격·글자 크기·모서리·그림자 토큰(:root), 강조색 하나(파랑 #1d5b9b), ok/warn/problem 색(본문 대비 모두 WCAG AA 이상), 시스템 글꼴(한·중 대체 글꼴 포함), 한국어 `word-break: keep-all`,
      상자·표·폼·버튼(주/보조 .plain/위험 .secondary/글자 .link)·배지·알림·목록·페이지 이동·정의 목록·머리글(자바스크립트 없이 줄바꿈)·바닥글·인쇄 스타일. 기존 클래스 이름은 그대로.
      표는 모두 `.table-wrap` 으로 감싸 좁은 화면에서 표 안에서만 가로로 넘김(제목 행이 있는 표는 640px 아래에서 최소 520px). 라디오·체크박스가 폭 100% 로 늘어나던 문제, 숫자·날짜 칸 폭, `.pre` 뒤 간격, 공고 목록의 기업 링크 색(강조를 제목 한 곳으로) 정리.
      첫 화면(`views/pages.Home`): 소개 + 버튼 2개(`/jobs`, 기업 `/biz` — 비로그인은 로그인 화면으로), 이용 방법(구직자 3·기업 3단계), 이 사이트가 다른 점 4개, 최신 공고(기존 질의·캐시 그대로), 자주 묻는 질문 5개(`<details>`).
      문구 `home.*` 한국어·중국어(옛 `home.lead`·`home.for_company` 는 지움). 문의처 질문은 운영자 이메일이 【확인 필요】라 넣지 않음. 관리자 첫 화면의 링크 줄을 `.menu` 로, 공고 폼의 저장·돌아가기를 `.actions` 로.
      라우트·lib·db·legal·마이그레이션은 고치지 않음. 테스트 변경 없음(604).
      확인: wrangler dev + Chromium(Playwright)으로 가짜 관리자(TOTP)·검증 기업·공고 3건·이력서·지원 1건을 만들고 16개 화면을 1280·360px(첫 화면·목록·상세는 중국어도) 스크린샷으로 확인,
      360px 가로 스크롤 없음(전에는 `/admin/system` 이 378px), `/`·`/jobs` 외부 요청 없음, 비로그인 `/` 응답 머리글이 바뀌기 전과 같음(miss 기준).
      하지 않은 것: 공개 기업 목록·상세, 기업 정보·서류·담당자, 관리자 기업·공고·항목·열람 기록, 면접 요청·불합격 화면, 점검 모드 화면은 스크린샷으로 보지 않았다(같은 부품만 씀).
      브랜드명·로고(8장 미정), 다크 모드, 관리자 설정 화면의 주 버튼 2개(상자마다 폼이 따로라 그대로 둠)
- [x] T-06d 공개 필터 표시 설정: `site_settings`(0006, key/value, `updated_by`·`updated_at`)와 `db/settings.ts`(getSetting·setSetting upsert).
      `public_job_filters` = `/jobs` 에 보일 필터의 JSON 배열(`lib/public-jobs.parseEnabledFilters`: 없으면 중국어 수준·보고 라인·근무지, 잘못된 값은 기본값,
      모르는 이름은 버림, 빈 배열 = 검색 칸 없음, 표시는 `FILTER_KEYS` 순서). 숨긴 필터는 모르는 조건과 같게 처리(`parseJobFilter`·`canonicalJobsHref` 에 목록을 넘김:
      걸러지지 않음, 개수에 안 듦, 정규화 302 에서 빠짐). 목록 줄·상세·공고 작성 폼·홈은 그대로. 관리자 `/admin/settings`(체크박스, 모르는 값 버림, 관리자 첫 화면에 링크).
      `/jobs` 는 캐시에 없는 요청마다 설정 한 행을 읽음(따로 캐시하지 않음) → 비로그인 화면 반영은 최대 60초(page-cache TTL).
      기존 테스트 "정규화 302 는 DB 를 읽지 않는다" 는 "설정 한 행만 읽고 공고는 읽지 않는다" 로 바꿈
- [x] T-06e 직무·업계·근무지 항목 관리: 세 선택 목록을 코드 상수·화면 문구에서 DB `job_options`(0007, `(kind, code)` 기본 키, 이름 한국어·중국어, 순서, 사용 여부)로 옮겼다.
      0007 이 이전 상수·문구 49개를 같은 code·이름·순서(10 간격)로 넣고, 상수 `ROLE_CATEGORIES`·`INDUSTRIES`·`LOCATIONS` 와 문구 `job.role.*`·`job.industry.*`·`job.location.*` 는 지웠다
      (`test/option-seed.ts` 에 옮기기 전 값을 적어 두고 0007 결과와 비교). `jobs` 의 세 컬럼은 그대로 TEXT code(외래키·데이터 변경 없음).
      `db/options.ts`(listOptions 한 번에 전체·insertOption·updateOption 이름·순서만·setOptionActive 한 문장 가드·countOptionUsage), 판단은 `lib/options.ts`
      (labelOf: 사용 종료·없는 code 도 표시, selectableCodes: 사용 중 + 편집하는 공고의 저장된 값, 관리자 입력 검사, 마지막 사용 중 항목 사용 종료 금지).
      공고 폼은 새 공고에 사용 중 항목만, 편집에는 저장된 사용 종료 값도 "(사용 종료)" 로 보이고, `validateJob` 은 같은 목록을 ctx 로 받는다
      (사용 종료 값은 저장된 값과 같을 때만 통과). 공개 목록·상세·홈·관리자 공고 화면은 labelOf 로 이름을 보이고, 공개 검색 칸·`parseJobFilter`·`canonicalJobsHref` 는
      사용 중 항목만 받는다(그 밖의 값은 모르는 값처럼 302 에서 빠짐). `/jobs` 는 설정 한 행 + 항목 목록을 동시에 읽은 뒤 정규화를 판단(공고는 읽지 않음), 따로 캐시하지 않음.
      관리자 `/admin/options`(종류별 표, 사용 공고 수, 이름·순서 수정, 사용 종료 ↔ 다시 사용, 추가, 삭제 없음, 관리자 첫 화면·사이트 설정에 링크).
      관리자 입력 이름에도 금지 표현 검사(`findBannedPhrases`). wrangler dev + Chromium(Playwright)으로 추가·사용 종료·이름 변경·위조 요청 거부 확인.
      일부러 뺀 것(나중에): 두 항목 합치기, 공고 분류 일괄 바꾸기(사용 종료한 항목의 공고를 다른 항목으로 옮기기), 항목 변경 이력 화면
- [x] T-07 이력서: 구직자 화면 `/my/resumes`(목록·새 이력서·수정·첨부파일 내려받기·복사·대표 지정·삭제 확인 화면 → 삭제), `/my` 와 머리글(구직자만)에 링크.
      회원당 5개(`insertResume` 한 문장 한도), 첫 이력서가 대표, 대표를 지우면 가장 최근에 고친 것이 대표. 필수 5개(이름·중국어 수준·경력 연차·한 줄 소개·연락 이메일, 기본값 계정 이메일)
      + 이력서 이름표(평문 저장이라 "기업에 보이지 않음, 이름·연락처 쓰지 말 것" 안내) + 선택 항목 + 첨부파일 1개. 이름·연락처·파일명을 포함한 내용 전체를 `body` 하나로 암호화(`lib/resume.ts`).
      첨부파일은 내용으로 판별한 **PDF·DOCX 만, 5MB**(기술설계서의 10MB 에서 줄임 — 무료 플랜 CPU 한도 안의 암호화), **Worker 에서 ENC_KEY 로 암호화한 뒤 R2 에 저장**
      (R2 키를 AAD 로 써서 다른 위치로 옮긴 객체는 풀리지 않음, 복사는 새 키로 다시 암호화) — 이 세 가지는 계획과 다르게 정한 것이다. 내려받기는 `serveResumeFile`(권한 → access_log → 복호화 → attachment) 만.
      권한은 `authz.canViewResume`·`canEditResume`(기업·헤드헌터는 원본 불가, 관리자는 사유 필요 — 관리자 열람 화면은 만들지 않음). 다른 구직자의 id 는 404, 기업·헤드헌터·관리자는 403, 모든 응답 `private, no-store`.
      수정은 `updated_at` 비교(다른 창에서 바뀌었으면 안내 + 입력값 유지, 다시 저장하면 덮어씀), 저장 시각은 예전 값보다 항상 커지게. 파일 정리 순서: 새 파일을 올린 뒤 DB 쓰기가 실패·거절되면 새 파일 삭제,
      교체·삭제된 예전 객체는 DB 갱신이 성공한 뒤 삭제, 이력서 삭제는 행을 지운 뒤 객체 삭제. 본문 `content-length` 가 6MB 를 넘으면 읽지 않고 413(입력값은 받지 못해 다시 입력해야 함).
      복호화할 수 없는 이력서는 목록에 "열 수 없는 이력서" + 삭제만, 편집·복사·내려받기는 404. console 에는 이력서 내용·이름·파일명을 쓰지 않음(실패 종류만). 마이그레이션 없음(0002 스키마).
      라우트 테스트 `test/resume-routes.test.ts`(SQLite 메모리 DB + 가짜 R2, console 감시). wrangler dev + Chromium(Playwright)으로 PDF·DOCX 올리기·내려받기 바이트 비교·대표 지정·교체·복사·삭제 승계·
      잘못된 파일·5MB 초과·6번째 거절·다른 구직자/기업 차단을 확인하고, 로컬 D1 에는 암호문만, R2 객체는 `RF1` 로 시작하며 원문이 없음을 직접 확인.
      남은 일: R2 고아 객체 정리(삭제 실패·요청 중단 때 남을 수 있음, `listResumeFileKeys` 와 R2 목록 비교) → T-12, 회원 탈퇴 시 이력서·파일 삭제 → T-11,
      관리자 사유 입력 열람 화면 → T-09, 지원에 이력서 쓰기(`resumeReadyToApply`) → T-08
- [x] T-08 지원: 공고 상세(`/jobs/:id`)의 "지원 준비 중" 안내를 지원 칸으로 바꿈 — 비로그인(캐시되는 화면)은 누구에게나 같은 "지원하기" 링크(`/jobs/:id/apply`),
      로그인한 구직자는 지원했으면 "이미 지원했습니다 · 지원 현황 보기", 기업·헤드헌터·관리자는 "구직자 계정으로만 지원" 안내(버튼 없음). 기업 연락처(mailto)는 그대로.
      지원 화면 `/jobs/:id/apply`(구직자만, 비로그인 → /login, 다른 역할 403, `private, no-store`, page-cache 없음): 보이지 않는 공고 404, 이미 지원했으면 그 지원으로 302,
      지원 가능한 이력서(`resumeReadyToApply`)가 없으면 이력서 안내 → 1단계 이력서 고르기(대표 기본 선택, 지원 불가 이력서는 사유와 함께 고를 수 없음, GET `?resume=`)
      → 2단계 한 화면에서 이번 지원에만 쓸 항목 수정(이력서 폼과 같은 칸·검사, 이름표 없음, 원본은 바뀌지 않는다는 안내), 첨부파일 이름 + "첨부파일 함께 보내기"(기본 체크, 새 업로드 없음),
      확인 상자(받는 곳 = 기업명 또는 "기업명 비공개" + 공고 제목, 보내는 항목, 기업 채용 담당자가 읽고 운영자는 검토·추천·전달하지 않음, 취소하면 내용 삭제),
      국외 이전 동의(`consentNeed(memberCounts)`: 본사 담당자 없음 → 칸 없음, 본사+한국 → 선택 체크(기본 해제, 해제 = 한국 담당자만 열람), 본사만 → 필수 체크, 없으면 제출 불가.
      문구는 locales `apply.consent.*` 의 초안 — 확정은 T-11, 판은 `CROSS_BORDER_VERSION` 을 저장만 하고 화면에 보이지 않음).
      제출(POST) 순서: 구직자·공고(공개 여부)·내 이력서 확인 → 항목 검사(오류는 400 + 입력 유지) → 동의 필요 여부 → 파일 복사 전 미리 `applyBlocks`(필요 없는 R2 쓰기 방지)
      → 첨부 복사(`copyResumeFile`, 새 R2 객체, 실패하면 첨부 없이) → 실제 복사본으로 `applyBlocks` 다시(첨부가 빠져 지원 불가가 되면 막고 안내) → `insertApplication`(문장 안에서 공개 조건·중복 재확인,
      거절·예외면 복사한 파일 삭제) → 성공한 뒤에만 기업 활성 담당자(최대 10명)에게 `new_applicant` 메일(공고 제목과 `/biz` 주소뿐, 실패해도 지원은 유지되고 구직자에게 오류로 보이지 않음, 로그는 일반 문구)
      → `/my/applications/:id?ok=applied`(첨부를 읽지 못해 빼고 냈으면 `applied_nofile`). **한 공고에 한 번만** 지원(취소한 공고도 다시 지원할 수 없음 — 지원 화면은 기존 지원으로 보냄).
      지원 현황 `/my/applications`(제목: 지금 공개 중이면 공고 링크, 아니면 글자만 — `db/application-views.listVisibleAppliedJobIds`, 기업명 또는 비공개 표시, 지원일, 구직자용 상태 이름 7개),
      `/my`·머리글(구직자)·`/my/resumes` 에서 링크. 한 건 `/my/applications/:id`(본인 것만, 남의 것 404, `canViewApplication` 확인, 기업이 보는 것과 같은 복사본 내용,
      동의 여부, 첨부 내려받기 `/file` = `serveApplicationFile`(access_log 기록). 본인이 화면을 보는 것은 기록하지 않음 — 이력서 화면과 같음). 복호화 실패·빈 내용은 500 이 아닌 안내 문구.
      취소: 확인 화면(GET, 내용·첨부 즉시 삭제, 기업이 더 볼 수 없음, 재지원 불가 안내) → POST `canWithdraw` → `withdrawApplication`(`nextStatus(…, 'withdrawn')`, 이벤트 + 내용·파일 키 삭제 + 동의 철회 한 트랜잭션)
      → DB 가 바뀐 뒤 R2 객체 삭제 → `?ok=withdrawn`. 끝난 지원·두 번째 취소는 400 안내. 지원 상태를 바꾸는 다른 길은 없음. 기업 쪽 지원자 화면은 만들지 않음(T-09).
      마이그레이션 없음(0008). 라우트 테스트 `test/apply-routes.test.ts`(SQLite 메모리 DB + 가짜 R2, console 감시: 메일 출력 외 없음·개인정보 없음).
      wrangler dev + Chromium(Playwright)으로 지원·수정·첨부 바이트 비교·필수 동의 차단/통과·중복·취소·재지원 거부·기업 403·다른 구직자 404 를 확인하고,
      로컬 D1 의 복사본은 암호문(취소 후 `''`), R2 객체는 `RF1` 로 시작하고 취소한 지원의 객체는 지워졌음을 직접 확인.
      남은 일: 기업 지원자 목록·열람(`viewed`)·관리자 사유 입력 열람 → T-09, 동의 문구 확정·`consents` 화면 → T-11, R2 고아 객체(복사·삭제 실패 때) 정리 → T-12,
      취소한 지원의 `cross_border_consent_at` 값은 지우지 않음(동의 철회는 `consents.withdrawn_at` 에 남고, 취소된 지원은 본인 말고 아무도 볼 수 없음 — authz)
- [x] T-09a 지원자 관리 1 (목록·열람·열람 기록). 보안 핵심(`lib/applicants.ts` `openApplication`·`downloadApplicationFile`, `db/applicants.ts`)은 먼저 따로 커밋하고, 화면은 그것만 쓴다.
      기업: `/biz/jobs` 공고마다 "지원 N건 · 새 지원 M건"(취소 제외, `countApplicationsByJob`) → 지원자 목록, `/biz` 첫 화면에 새 지원 요약(알림 메일이 `/biz` 로 연결).
      지원자 목록 `/biz/jobs/:id/applicants`(`canEditJob`, 남의 공고 404): 지원 순서 번호·지원일·기업용 상태 이름·첨부 여부만 — **이름·연락처·한 줄 소개 등 개인정보 없음**,
      정렬·점수·추천 표시·메모·내보내기·전달·상태 변경 버튼 없음. 취소된 지원은 링크 없는 "지원 취소됨", 본사 소속 담당자에게 동의 없는 지원은 링크 없는 "국외 이전 동의 없음 — 한국 담당자만 열람 가능".
      지원서 `/biz/applications/:id`: 이 기업의 지원서가 아니면 404 → `openApplication` 한 번(권한 → 복호화 → access_log → 처음 열면 `viewed` 이벤트로 상태 변경). 취소됨·동의 없음(403)·열 수 없음은 안내 화면, 기록 없음.
      내용은 구직자 본인 화면과 같은 조각(`SnapshotFields`). 첨부 `/biz/applications/:id/file` = `downloadApplicationFile`(기록 한 줄, 상태 변경 없음).
      HEAD 는 405, 브라우저 미리 가져오기(`Sec-Purpose`/`Purpose: prefetch·prerender`)는 503 으로 기록 전에 거절(`routes/guards.humanGetOnly`, 권한 검사보다 먼저).
      구직자: `/my/applications/:id` 에 "열람 기록"(시각 + 역할: 기업 채용 담당자·운영자만, 이름·이메일·사유 없음, 본인 내려받기 제외, 취소한 지원에는 없음).
      관리자: `/admin/applications/:id` 는 개인정보 없는 정보(공고·기업 id·날짜·상태·동의/첨부 여부) + 사유 폼(필수, 300자)만이고 기록하지 않음.
      `POST /admin/applications/:id/open` 사유 → 내용은 POST 응답에만(리다이렉트 없음), 기록에 사유, 상태 변경 없음. 첨부는 `POST /admin/applications/:id/file`(사유 함께).
      관리자 지원자 목록·사람 검색·수정·전달·일괄 내려받기는 없다. `/admin/access-log`: 50건씩 최근 순, `?type=application|resume|verification_doc`(그 밖의 값은 무시), `?before=` 커서
      (커서가 시각뿐이라 페이지 끝과 같은 초의 줄은 다음 페이지로 넘김 — 한 초에 50줄을 넘으면 빠질 수 있음), 지원서 줄은 관리자 지원서 화면으로 연결, 관리자 첫 화면에 링크.
      위 화면은 모두 `private, no-store`(로그인 리다이렉트·403 포함). 마이그레이션 없음. 라우트 테스트 `test/applicant-routes.test.ts`(11개, console 감시).
      wrangler dev + Chromium(Playwright)으로 목록(이름 없음)·열람·첨부 바이트 비교·구직자 상태/열람 기록·본사 담당자 차단/동의 지원 열람·다른 기업 404·취소 후 목록/직접 주소·
      관리자 TOTP 로그인 후 사유 열람·열람 기록 화면·중국어 화면을 확인하고, 로컬 D1 의 access_log 가 수행한 열람과 같고(막힌 시도는 없음) `viewed` 가 지원서마다 한 번임을 확인
- [x] T-09b 지원자 관리 2 (기업 → 지원자 메일). 핵심(`lib/applicant-mail.ts`, `lib/localize/message.ts`, `db/applicants.recordMailEvent`·`countEvents`)은 먼저 따로 커밋하고, 화면은 그것만 쓴다.
      보내는 사람: 그 공고 기업의 담당자뿐(본사 소속은 국외 이전에 동의한 지원만). **관리자·운영자가 지원자에게 메일을 보내는 경로는 없다.** 화면은 지원서를 풀지 않고 받는 주소를 모른다.
      면접 요청: 지원서 화면(진행 중일 때)의 쓰기 칸 → `POST /biz/applications/:id/interview/preview`(`readMessage` 2000자, 자동 번역 `translateMessage` — 엔진에는 메시지 글만)
      → 원문 | 한국어 자동 번역 나란히 + "번역 없이 원문만 보내기", 엔진 없음·실패면 원문만 → `…/send` → `sendInterviewRequest`. 메일 = 한국어 안내문 + 자동 번역(밝힘) + 원문 그대로,
      답장 주소 = 보낸 담당자의 로그인 이메일(쓰기 화면에 지원자에게 보인다고 안내). 한 지원에 3번까지. "고치기" 는 POST(`…/compose`)로 글 유지. 예문·추천 답장 없음.
      불합격 통보: 지원자 목록의 체크 칸(진행 중인 줄만, 본사 담당자에게 동의 없는 줄은 없음) 또는 지원서 화면의 한 건 → `POST /biz/jobs/:id/applicants/reject/confirm`
      (보낼 수, 보낼 정해진 글 그대로 — 중국어 화면은 같은 문구 키의 중국어 참고, 되돌릴 수 없음·상태 "불합격"·답장 주소 안내) → `…/send` 한 번에 10건까지 한 건씩 차례로 `sendRejection`.
      사유 칸 없음. 다른 공고·다른 기업의 id 가 섞이면 요청 전체 404, 끝난 지원은 빼고 센다.
      순서는 메일 발송 → 이벤트(`interview_mail`·`reject_mail`) + 상태: 메일이 나가지 않으면 기록·상태 변화가 없고(글을 지닌 화면으로 다시 시도), 그사이 상태가 바뀌었으면 "보냈지만 기록되지 않음".
      보낸 뒤에는 지원자 목록으로 303(`?ok=interview`, `?ok=rejected&sent=N&failed=M` 숫자만 — 지원서 화면으로 가면 열람이 또 기록되므로). 목록에 "면접 요청 N회"(`db/applicant-views.countInterviewMailsByJob`, 묶음 조회 한 번).
      메시지 글은 POST 본문으로만 오가며 주소·로그·`email_log`·D1 에 남지 않는다. 모든 응답 `private, no-store`. 마이그레이션 없음. 라우트 테스트 `test/applicant-mail-routes.test.ts`(8개, console 감시, Resend·번역 엔진 가짜).
      wrangler dev + Chromium(Playwright)으로 면접 요청(엔진 없음 → 원문만)·불합격 2건·구직자 상태·끝난 지원 거절·다른 기업 404·중국어 화면을 확인하고,
      로컬 D1 에 `interview_mail` 1·`reject_mail` 2 이벤트, `email_log` 3줄(템플릿 이름·결과·주소 해시), 메시지 글·연락 이메일 평문이 없음을 확인.
      남은 일: 번역 엔진 실호출 확인(T-05b 와 함께, 키 발급 뒤), 미리 보기의 번역은 숨은 칸으로 돌아오므로 담당자가 고쳐 보낼 수 있다(자기 메시지이므로 허용, 메일에는 "자동 번역" 으로 표시됨 —
      서명으로 묶을지 운영자 판단), 기업당 하루 메일 수 한도(→ T-05c 에서 함), 메일 API 가 느릴 때 10건 차례 발송의 처리 시간(무료 플랜 한도) 실측,
      상태 "검토 중"(`summary_shared`)을 만드는 화면은 아직 없음
- [x] T-11 약관·개인정보처리방침·동의·회원 탈퇴. 핵심(`src/legal/`, `lib/consent.ts`, `db/consents.ts`, `lib/account.ts`, `db/account.ts`, `test/account.test.ts`)은 먼저 따로 커밋하고, 화면은 그것만 쓴다.
      문서 `/terms`·`/privacy`(현재 언어, JSX 출력, 주소는 글자 그대로, 비로그인은 page-cache 60초), 모든 화면 바닥글·로그인 화면에서 링크.
      동의 확인 미들웨어(`src/index.tsx`, 세션·언어 뒤): 로그인한 관리자 아닌 회원이 지금 판의 `terms`·`privacy` 동의가 없으면 GET·HEAD → `/consent?next=`(`safeNext` 가 받는 경로만), 그 밖 → 403, 모두 no-store.
      비로그인은 아무것도 읽지 않음(공개 캐시 화면은 D1 을 읽지 않음), 예외 주소(`consentExempt`)와 `public/` 파일(`lib/static-files.ts`)은 확인하지 않음. 로그인한 요청마다 작은 읽기 한 번(캐시 없음).
      `/consent`: 빠진 종류의 체크 칸만(미리 체크 없음), 수집 항목·목적·보유 기간·국외 보관(Cloudflare·Resend) 요약, 탈퇴·로그아웃 안내 → POST 는 빠진 종류만 기록 → 303 `next`. 하나라도 빠지면 400, 기록 없음.
      `/my/account`(모든 로그인 회원, `/my`·`/biz`·머리글 "계정" 에서 링크): 이메일·유형·동의 내역(판만 — 동의 시각은 핵심 함수가 돌려주지 않음)·문서·회원 탈퇴 입구, 관리자·다른 담당자가 있는 대표는 이유만.
      `/my/account/delete`: 지워지는 것·남는 것 안내 + 로그인 이메일 입력 → `deleteAccount` → `logout()` 으로 쿠키 삭제 → `/?bye=1`(홈 한 줄 안내, 이 요청은 page-cache 를 거치지 않음 — `routes/jobs.homeCache`).
      `/consent`·`/my/account*` 모든 응답 no-store. 마이그레이션 없음. 라우트 테스트 `test/account-routes.test.ts`(21개, console 감시), 기존 라우트 테스트는 로그인시키는 사용자에게 동의 행을 넣도록 고침(`test/consent-fixture.ts`).
      wrangler dev + Chromium(Playwright)으로 문서(한·중)·가입 → 동의 화면 → 동의 전 막힘 → 동의 후 원래 주소·이력서(PDF)·지원·탈퇴(틀린 이메일 거부 → 맞는 이메일)·로컬 D1/R2 확인(계정 익명화, 이력서 없음, 지원서 내용 빈 값 + withdrawn 이벤트,
      R2 객체 삭제, 동의 `withdrawn_at`, 열람 기록 유지)·같은 이메일 재가입은 새 계정 + 동의 다시·대표 담당자 차단·중국어 화면 확인.
      **운영자 할 일 (운영 서버에 올리기 전에, README "이용약관·개인정보처리방침"):**
        1) `src/legal/types.ts`·`terms.ts`·`privacy.ts` 의 `【확인 필요】`(중국어 `【待确认】`)를 모두 채운다 — 상호·대표자·주소·문의 이메일·개인정보 보호책임자·신고번호·시행일·동의 기록 보관 기간·위탁 계약(DPA) 체결 여부
        2) 두 문서를 노무·개인정보 전문가에게 검토받는다 (문서 내용 = 실제 동작인지 포함)
        3) 시행일을 정해 적고, 채운 뒤 `test/account.test.ts` 마지막 테스트를 `toBe(0)` 으로 바꾼다
        4) 문서를 고칠 때마다 `lib/consent.ts` 의 `TERMS_VERSION`·`PRIVACY_VERSION`(국외 이전 문구는 `CROSS_BORDER_VERSION`)을 올린다
      남은 일: 대표 담당자 넘기기(지금은 다른 담당자가 있는 대표는 탈퇴 불가), 동의 시각을 계정 화면에 보이기(`listRequiredConsents` 에 `agreed_at` 추가 필요),
      관리자 계정 탈퇴 방법(지금은 README 의 SQL 로 역할을 바꾼 뒤), 탈퇴 후 남는 행의 보관 기간이 지나면 지우기 → T-12, 탈퇴 때 R2 삭제 실패로 남은 객체 정리 → T-12
- [x] T-12 예약 작업 (자동 마감·보관 기한 삭제·정리). cron 을 매시 정각 한 번(`"0 * * * *"`)으로 바꾸고 실행마다 **단계 하나만** 한다(`lib/maintenance.SCHEDULE`, UTC 시각 → 단계, 24칸):
      00 report · 01 closeJobs · 02 markApplications · 03 purgeApplications · 04 dropOldRows · 05 sweepOrphans · 06 purgeVerificationDocs · 07 closeJobs · 08 markApplications · 09 purgeApplications ·
      10 dropOldRows · 11 sweepOrphans · 12 closeJobs · 13 markApplications · 14 purgeApplications · 15 purgeVerificationDocs · 16 sweepOrphans · 17 closeJobs · 18 markApplications · 19 purgeApplications ·
      20 dropOldRows · 21 sweepOrphans · 22 closeJobs · 23 purgeApplications (하루 closeJobs 5 · purgeApplications 5 · markApplications 4 · sweepOrphans 4 · dropOldRows 3 · purgeVerificationDocs 2 · report 1).
      한 번 실행 상한(`CAPS`): 공고 마감 10 · 안내 공고 10 · 안내 메일 10 · 지원 기한 붙이기/떼기/자동 종료 각 50 · 내용 삭제 10 · 표마다 행 삭제 200 · 서류 5 · R2 목록 100 · 고아 삭제 10 · 참조 확인 IN 50개,
      실행당 D1 문장 25개 이하(batch 안 문장도 하나씩 셈, 집계 기록 2개 포함)·R2 호출 15개 이하(`BUDGET`, 테스트가 후보를 상한보다 많이 넣고 셈). 남은 것은 다음 차례에.
      기간 상수는 `lib/retention.ts` 한 곳(지원서 180일·자동 종료 30일·서류 1년·열람 기록 2년·내용 없는 행과 철회된 동의 2년·메일 기록 1년·무수정 30일·안내 3일 전·고아 24시간), 개인정보처리방침 3항 글(한·중)에 같은 숫자가 있는지 테스트.
      SQL 은 새 파일 `src/db/maintenance.ts` 에만(모든 UPDATE·DELETE 에 시간 조건 + 한도 + 지우는 것 주석), 마이그레이션 0009(`jobs.close_notice_at`, 인덱스 `applications(purge_after)`·`access_log(at)`·`email_log(sent_at)`).
      단계: closeJobs(마감일 지남 → closed, 마감일 없음 + 무수정 30일 + 안내 후 3일 → closed, 3일 전 활성 담당자에게 `job_close_notice` 한·중 메일 한 번, 저장하면 `close_notice_at` 초기화 — `db/jobs.ts` 의 기업 저장 세 문장, 초안·차단 공고는 안 건드림, 게재 없음) ·
      markApplications(마감·차단 공고 지원에 `purge_after = 확인 시각 + 180일`, 30일 지난 진행 중 지원 `auto_closed` 이벤트 + 상태를 한 batch 로 — 상태는 방금 넣은 이벤트가 있을 때만, 차단이 풀린 공고의 진행 중 지원은 기한 떼기) ·
      purgeApplications(기한 지난 지원 10건: D1 먼저 내용·파일 키·요약 삭제 + 진행 중이면 auto_closed + 국외 이전 동의 철회 → 아무 행도 가리키지 않는 `rfiles/` 객체만 R2 삭제, 실패는 세고 고아 정리에 맡김) ·
      dropOldRows(표마다 200행, 자식 먼저: 내용 없는 지원의 이벤트·행 2년, 철회된 동의 2년, 열람 기록 2년, 메일 기록 1년, 만료 세션·인증코드·2단계 대기, users·초대는 안 건드림) ·
      purgeVerificationDocs(확인 후 1년 지난 승인·반려 서류 5건, 행 먼저 → `vdocs/` 객체, 확인 대기 서류 안 건드림, 서류가 없어진 검증 완료 기업은 그대로 검증 완료) ·
      sweepOrphans(`rfiles/` 목록 100개씩 커서 `maint.rfiles_cursor`, 24시간 지났고 resumes·applications 어디도 가리키지 않는 객체 10개까지, 참조 확인 실패면 하나도 안 지움) ·
      report(00 UTC, `OPS_EMAIL` 이 있으면 전날 단계별 처리 수 + 개수만 평문 메일, 집계는 `maint.stats.<날짜>`, 7일 지난 집계 삭제).
      실행기 `runMaintenance`: 예외를 밖으로 내지 않고 로그 한 줄 `maint: step=… ok|failed counts={숫자}`(키·이메일·id·오류 내용 없음), `scheduled` 에서 `ctx.waitUntil`. HTTP 경로 없음.
      개발용 단계 고르기는 cron 문자열 `maint:<단계>` 이고 `APP_ENV === 'dev'` 일 때만(README). 새 선택 변수 `OPS_EMAIL`(기본 빈 값). 테스트 `test/maintenance.test.ts`(44개, SQLite + 외래키 켬 + 가짜 R2),
      `test/sqlite-d1.ts` 의 batch 가 SELECT 결과를 돌려주도록 고침(D1 과 같게). wrangler dev(4.166)로 로컬 D1·R2 에 가짜 행을 넣고 단계마다 실행해 전후를 확인.
      정한 것: 무수정 마감은 안내를 보낸 지 3일이 지나야 한다(안내 없이 마감되지 않게 — 그래서 실제 마감은 max(무수정 30일, 안내 + 3일)), 담당자 없는 공고는 메일 없이 안내 완료로 표시,
      기한이 지난 지원은 공고 상태와 관계없이 지움, 시간표는 `hour % 단계 수` 대신 24칸 표(보고를 하루 한 번으로 하기 위해), 보고 메일은 운영자용이라 한국어만.
      남은 일 → T-12b
- [x] T-05c 남용 방지 한도 (번역 호출·메일 발송·초안 개수). 숫자는 `src/lib/quota.ts` 한 곳(`DEFAULT_LIMITS`)에 있고 같은 이름의 vars 로 바꾼다
      (`limitsOf`: 앞뒤 공백을 뺀 0~1,000,000 정수만, 비었거나 잘못된 값은 기본값, 0 = 쓰지 않음, `wrangler.jsonc` 에 빈 값으로 적어 둠). 하루는 한국 시간(`kstDay`).
      하루 횟수는 새 표 `usage_counters`(0010, (scope, subject, day) 기본 키, subject = 기업 id·관리자 id·`'site'` 뿐 — 이메일·IP 없음)에
      `db/usage.takeQuota` 한 문장(`INSERT … SELECT … WHERE cost <= limit ON CONFLICT DO UPDATE … WHERE n + cost <= limit`)으로 센다 — 동시에 와도 한도를 넘지 않음. 되돌리기 없음(실패해도 한 번 씀).

      | 한도 (기본값) | 세는 것 | 잡는 곳 (항상 기업·관리자 몫 → 사이트 몫) | 걸리면 |
      |---|---|---|---|
      | `LOCALIZE_PER_COMPANY_DAY` (30/기업/일) | 공고 현지화·다시 만들기·면접 요청 번역 미리 보기 (한 몫) | `POST /biz/jobs/:id/localize` (엔진 없음 검사·20초 자리 잡기 뒤, 엔진 전), `POST /biz/applications/:id/interview/preview` (엔진이 있을 때만) | 현지화 400 + 안내(수동 입력 칸 그대로) / 미리 보기는 원문만 + 안내, 보내기는 됨 |
      | `LOCALIZE_SITE_DAY` (500/일) | 위 + 관리자 엔진 비교 | 위 + `POST /admin/localize-test` | 위와 같음 |
      | `ADMIN_LOCALIZE_TEST_DAY` (50/관리자/일) | 엔진 비교, 고른 엔진마다 1 | `POST /admin/localize-test` | 400 + 안내, 엔진 호출 없음 |
      | `MAIL_PER_COMPANY_DAY` (100/기업/일) | 면접 요청·불합격 통보(한 통마다)·담당자 초대 메일 | `…/interview/send`, `…/reject/send`(한 통마다, 처음 걸린 곳에서 멈춤), `POST /biz/members/invite`(실제로 보낼 때만) — 메일 핵심 함수 전 | 보내지 않음·기록 없음. 면접 400 + 글 유지 / 불합격 `&limited=K&pool=` 안내 / 초대 저장 + "직접 알려 주세요" |
      | `MAIL_SITE_DAY` (1000/일) | 위 세 가지 합계 (로그인 코드·새 지원자 알림·예약 작업 메일 제외) | 위와 같음 | 위와 같음 |
      | `DRAFT_JOBS_PER_COMPANY` (20/기업, 개수) | `status NOT IN ('published','closed')` (초안·차단), 헤드헌터 공고 제외 | `POST /biz/jobs/new` — `insertJob` 에 개수 조건을 붙인 한 문장 | 400 + 입력 유지 + 안내 |

      관리자 첫 화면에 "오늘 사용량"(사이트 번역 호출·기업 메일 `쓴 수 / 한도`, 읽기 두 번). 기업 화면에는 그 요청에서 걸렸을 때만 안내(한·중, 숫자는 `{n}`).
      예약 작업 dropOldRows 에 35일 지난 `usage_counters` 삭제를 더함(200행, 행 값 IN, 결과에 `usage_counters`, batch 9문장 + 집계 2 = 11 ≤ 25).
      테스트 `test/quota.test.ts`(16: KST 자정 경계·변수 해석·takeQuota 한도/독립/cost/동시성·몫 순서), `test/quota-routes.test.ts`(16, app.fetch: 현지화 기업·사이트 한도·엔진 없음·날짜 바뀜,
      미리 보기 원문만, 보내기·불합격 묶음·사이트 메일 한도, 초대 한도·미검증 기업, 초안 한도, 관리자 비교 한도, 관리자 사용량, 평소엔 안내 없음, 카운터에 id 만),
      `test/maintenance.test.ts` 의 dropOldRows 테스트에 사용량 행(35일 경계)을 더하고 결과 모양을 고침 + 200행 테스트 하나.
      wrangler dev(한도 2/2/2) + Chromium 으로 세 번째 초안 거절·세 번째 초대 메일 한도·중국어 안내·관리자 사용량 상자·엔진 없을 때 카운터 없음 확인.
      정한 것: 엔진이 없으면 한도를 쓰지 않음(현지화는 기존 no_engine 검사가 자리 잡기·한도보다 먼저), 사이트 몫 거절 때 기업 몫은 되돌리지 않음,
      초안 한도에 차단 공고도 셈(브리프의 "non-closed, non-published"), 0 은 "끄기"로 받음, 사이트 메일 한도 안내에는 숫자를 보이지 않음(기업에게 사이트 전체 수치를 알리지 않음, 관리자 화면에는 보임).
      남은 일: 초안을 지우거나 마감하는 길이 없다(마감은 게재 중 공고만) — 게재할 수 없는 기업(미검증)은 초안 20개에서 멈춘다. 초안 삭제·보관 기능이 필요한지 운영자 판단,
      기업 화면에 "오늘 남은 번역 N회" 표시(지금은 걸렸을 때만), 메일 핵심 함수가 거절할 때(끝난 지원 등)도 메일 몫이 하나 줄어듦(게이트가 대부분 먼저 거른다),
      PostgreSQL 이전 때 UPSERT 동시성 확인(docs/DB-PORTING.md)
- [x] T-12c 보관 기간을 관리자가 설정 + 쓰지 않은 초안 삭제. **운영자와 정한 법적 원칙:** 개인정보(지원서·첨부·사업자 서류·열람 기록)는 기간이 끝나면 반드시 지운다 —
      "영구 보관"·"지우지 않고 비활성화" 는 없다(개인정보 기간에는 0 이 없고 위아래 한도). 개인정보가 아닌 공고 무수정 자동 마감만 끌 수 있다. 방침·동의 문구는 항상 지금 숫자를 보이고, 늘린 기간은 소급하지 않는다.

      | 설정 (`site_settings.retention`, JSON 한 줄) | 기본 | 범위 |
      |---|---|---|
      | `application_keep_days` 지원서 보관: 공고 마감(확인) 후 | 180 | 30~365 |
      | `application_auto_close_days` 결과 미정 지원 → "채용 종료" | 30 | 7~90, 보관보다 짧게 |
      | `vdoc_keep_days` 사업자 서류: 확인 후 | 365 | 90~1095 |
      | `access_log_keep_days` 열람 기록 | 730 | 365~1825 |
      | `job_stale_days` 마감일 없는 공고 자동 마감 | 30 | 14~180 또는 0(끔) |

      바꿀 수 없는 것(상수): 내용 없는 행·철회된 동의 2년, 메일 기록 1년, 고아 24시간, 마감 안내 3일 전, 하루 사용량 35일.
      `lib/retention.ts`(RETENTION_SPEC·parseRetention: 잘못된·범위 밖 값은 **그 칸의 기본값**, 자동 종료 ≥ 보관이면 min(기본, 보관 - 1) · validateRetentionForm · planRetentionSave · 변경 기록),
      `lib/retention-setting.loadRetention`(기본 키 한 행), `legal/render.ts`(renderLegal·tRetention: 자리표시자 → "N일"/"N天", 서류·열람 기록은 365 배수면 "N년"/"N年").
      **예약 작업:** `runMaintenance` 가 실행마다 설정을 한 번 읽어 단계에 넘김(읽기 실패 = 실행 안 함·failed, 기본값으로 대신 지우지 않음, 문장 예산에 셈 — 단계별 최대 18). `job_stale_days = 0` 이면 무수정 마감·그 안내를 건너뜀(마감일 마감은 그대로).
      **지원서 MIN 규칙:** 0011 `applications.keep_days`(지원할 때의 설정, NULL = 이전 지원 = 180). 실제 보관 = MIN(COALESCE(keep_days, 180), 지금 설정), 자동 종료 = MIN(설정, 실제 보관 - 1) — SQL(`db/maintenance` effKeep).
      줄이면 이미 붙은 기한도 `lowerPurgeAfter` 가 "지금 + 실제 보관" 으로 **당김**(늦추지 않음, 마감 확인 시각을 저장하지 않으므로 줄인 기간은 그 단계가 본 때부터 셈 — 보수적, 50건씩, 시간 가드·LIMIT·주석).
      지원 화면은 숨은 칸으로 보인 기간을 보내고 지원에는 MIN(보인 값, 지금 설정) 을 남김(화면을 연 뒤 늘어도 읽은 것보다 길게 붙지 않음).
      **다시 동의:** 설정의 `rev` 는 개인정보 기간(지원서·서류·열람 기록)이 하나라도 **늘 때만** +1 → 방침 판 `PRIVACY_VERSION+r<rev>`(`lib/consent.privacyVersion`·`requiredConsents(설정)`, `missingConsents(rows, required)`).
      동의 확인 미들웨어는 로그인한 요청마다 동의 + 설정 한 행(동시에, 캐시 없음). 줄이기·자동 종료·자동 마감 변경은 다시 묻지 않음. 국외 이전 동의 판은 `CROSS_BORDER_VERSION/k<일>`.
      **문구:** `privacy.ts` 의 설정 기간 숫자 8곳(한·중)과 locales `consent.privacy.keep`·`apply.consent.*.text`·`mail.job_close.reason.stale`·새 `mail.job_close.stale_line` 을 자리표시자로(글은 그대로). `/privacy`(비로그인 캐시 60초)·`/consent`·계정·지원 화면이 지금 숫자로 채움.
      **관리자 화면** `/admin/settings` "보관 기간": 범위·안내(반드시 삭제, 줄이면 되돌릴 수 없음, 늘리면 새 지원서에만 + 모두 다시 동의, 방침 자동 반영) → 확인 화면(old → new, 결과, "확인했습니다" 필수, 숨은 `base` 로 그사이 변경 감지) → 저장(`updated_by`) +
      `retention.log`(최근 20줄, 시각·관리자 id·숫자만, 같은 트랜잭션). 마지막 변경 누가·언제, 최근 변경 5줄.
      **초안 삭제:** `GET·POST /biz/jobs/:id/delete` — 초안 + 게재된 적 없음(`published_at IS NULL`) + 지원 없음(취소 포함)일 때만(`lib/jobs.draftDeletable`), `db/jobs.deleteUnusedDraft` 한 문장이 세 조건과 기업을 다시 확인.
      목록·공고 화면의 "삭제" 는 그런 초안에만. 게재 중·마감·차단·예전에 게재된 공고는 지울 수 없음. 초안 한도 안내에 삭제를 적음.
      **일부러 안 되게 한 것과 이유:** 개인정보 영구 보관·삭제 대신 숨기기(법적 원칙), 범위 밖 값(오입력으로 대량 삭제·무기한 보관 방지), 늘린 기간의 소급(더 짧은 약속으로 받은 지원서),
      당긴 기한 되돌리기(지운 뒤 되돌릴 수 없고 약속보다 길어짐), 게재된 적 있는 공고 삭제(공개 기록·지원 보존), 화면 없는 설정 변경(HTTP 경로는 관리자 두 단계뿐).
      테스트: `test/retention.test.ts`(19), `test/retention-routes.test.ts`(15), `test/maintenance.test.ts` "보관 기간 설정"(10), apply-routes 1. 기존 테스트 변경은 기계적(동의 판 인자·렌더 후 비교·keepDays 인자·`/k180`·집계 실패 정규식).
      wrangler dev + Chromium(Playwright)으로 180 → 90(줄이기, 확인 화면) → `/privacy` 한·중 90·지원 동의 문구 90·기존 회원 다시 묻지 않음 → 90 → 120(늘리기) → 구직자·기업 `/consent`, `+r1` 개인정보 동의만 새로 →
      자동 마감 끔 + closeJobs(무수정 공고 그대로, 마감일 지난 공고 마감) → keep_days 가 다른 지원의 markApplications·purgeApplications(MIN 규칙·당기기·늦추지 않음) → 초안 삭제·게재 공고 거절 확인.
      남은 일: 사업자 서류·열람 기록은 자료마다 기간을 남기지 않아 늘린 기간이 이미 있는 자료에도 적용됨(운영자·전문가 판단 — 필요하면 지원서처럼 행마다 기간 저장),
      늘린 뒤 다시 동의를 거부한 회원의 처리(지금은 탈퇴 외에 쓸 수 없음 — 설계대로), 자동 마감을 끄기 전에 보낸 무수정 마감 안내 메일은 그대로 나간 상태(마감은 되지 않음)
- [x] T-13 운영 환경 분리·배포 절차·백업. `wrangler.jsonc`: 맨 위 = 테스트(`recruit-test`, Custom Domain `recruit.kimbbob.xyz`, `workers_dev`·`preview_urls` 끔),
      `env.production` = 운영(`recruit`, D1 `recruit-prod`, R2 `recruit-prod-files`, 도메인·D1 id 는 `REPLACE_WITH_…` 자리표시자, 물려지지 않는 vars·d1·r2·ai·secrets 를 모두 다시 적음,
      triggers·observability 도 같은 값으로 다시 적음, Workers AI 바인딩, `secrets.required` = ENC_KEY·SESSION_PEPPER·RESEND_API_KEY). Workers Logs 켬(`invocation_logs: false` — 코드가 찍은 줄만).
      Workers AI 는 운영에만: 맨 위에 두면 로그인하지 않은 PC 의 `wrangler dev` 가 "Failed to start the remote proxy session" 으로 시작되지 않음을 이 저장소에서 직접 확인.
      안전장치: `lib/email.ts` 는 키가 없을 때 **`APP_ENV === 'dev'` 에서만** 콘솔 출력(테스트·운영은 `no_api_key`, 출력 없음 → 테스트 서버도 Resend 키가 있어야 로그인 가능),
      `lib/config-check.ts`(순수 함수: ENC_KEY 32바이트·SESSION_PEPPER 길이/로컬 예시 값·APP_ORIGIN https/자리표시자·MAIL_FROM·Resend 키·신고번호·【확인 필요】 개수·운영자 도메인·플래그·D1/R2·점검 모드·엔진,
      비밀값은 설정됨/없음 + 길이 구간만) → 관리자 `GET /admin/system`(no-store, 점검 표·비밀값 유무·오늘 사용량·보관 기간(읽기만)·cron 시간표, 마이그레이션 수는 런타임에 알 수 없어 안내만, 관리자 첫 화면에 링크),
      점검 모드 `MAINTENANCE=on`(`lib/pause.ts` + `src/index.tsx` 미들웨어: 관리자·`/login*`·`/logout`·`/lang/*`·`/admin*`·`/api/health`·정적 파일 말고 503 한·중 + Retry-After + no-store,
      라우트보다 먼저라 page-cache 를 읽지 않음). `/api/health` 는 그대로 `{ok, env}`. 스크립트(새 의존성 없음): `scripts/predeploy.mjs`(test: typecheck·테스트·자리표시자 / prod: + 약관 표시(주석 제외)·신고번호·주소 일치·workers_dev·git main·깨끗한 작업 트리),
      `deploy.mjs`(npm 이 `predeploy:*` 를 먼저 돌리고 15분 안 같은 코드면 다시 하지 않음, 운영은 도메인 입력 확인), `db-migrate.mjs`(운영은 백업 확인 + 도메인 입력), `backup.mjs`(`wrangler d1 export --remote` → AES-256-GCM + scrypt(N=2^17) 비밀문구 → `backups/<env>-<yyyymmdd-hhmm>.sql.enc`, 평문 임시 파일 삭제),
      `restore-decrypt.mjs`, Windows `deploy-test.bat`·`backup-prod.bat`. 운영자 안내 `docs/DEPLOY.md`. 테스트 47개 추가(config-check 15·email 5·pause/system 10·deploy-checks 11·backup-crypto 6).
      **확인한 것:** typecheck·테스트 604, `wrangler deploy --dry-run`(테스트·운영 둘 다 설정 해석 — 자리표시자는 dry-run 이 잡지 않음 → predeploy 가 잡음), `predeploy:test`·`predeploy:prod` 가 지금 상태에서 막힘,
      로컬 `wrangler dev`(로그인 안 함): `/`·`/login`·관리자 TOTP 로그인·`/admin/system`, `APP_ENV:test` 에서 인증코드 미출력 + "메일을 보내지 못했습니다" + `email_log` `no_api_key`, `MAINTENANCE:on` 503(한·중), 로컬 D1 export → 암호화 → 복호화 바이트 동일.
      **확인하지 못한 것 (Cloudflare 계정 없음):** 실제 배포·Custom Domain 자동 연결·인증서, `secrets.required` 로 배포가 막히는지와 아직 없는 Worker 에 `secret put`, `wrangler d1 export --remote` 와 백업 파일을 새 D1 에 넣는 복구,
      Time Travel 명령, 롤백, Workers Logs 에 cron 의 console 줄이 보이는지, `--var MAINTENANCE:on` 배포, Resend 도메인 인증·발송, Cloudflare Access, Workers AI 운영 호출.
      남은 일: 복구 연습(O-7) 뒤 DEPLOY.md 5-3 표시 지우기, R2 파일 백업 여부 결정(지금은 하지 않음 — DEPLOY.md 5-4), 운영 전 약관 표시를 채우면 `test/config-check.test.ts`·`test/deploy-checks.test.ts` 의 "> 0" 줄도 0 기준으로
- [x] T-10 조건 알림 (docs/ARCHITECTURE.md 17절). 구직자가 `/jobs` 에서 직접 고른 조건을 저장하고 그 조건의 **새 공고**를 메일로 받는다 — 추천·알선이 아니다
      (이력서·지원 기록 안 씀, 순위·점수 없음, 게재 최신 순뿐, `publicJobWhere` 로 `/jobs` 에 보이는 공고만, 관리자·기업이 보내는 길 없음, 관리자에게는 개수만).
      **데이터(0012):** 0001 의 `alerts` 표에 컬럼을 더함(`status`·`paused_reason`·`next_due_at`·`checked_until`·`fail_count`·`optin_at`·`optin_version`·`updated_at`, 인덱스 2) —
      `db/account.eraseUser` 가 이미 `DELETE FROM alerts WHERE seeker_id = ?` 를 하므로 **탈퇴 때 알림이 지워지고 보호 파일을 고칠 필요가 없다.** 해지 토큰 `alert_unsub_tokens`(SHA-256 해시만, 메일마다 새 토큰, ON DELETE CASCADE — 탈퇴 DELETE 를 막지 않음을 테스트).
      조건은 `/jobs` 파서(`parseJobFilter`) 결과를 FILTER_KEYS 순서 JSON 으로(다른 문법 없음, 검색어 칸이 없어 검색어 없음), 한 사람 5개, 같은 조건 하나.
      **화면:** `/jobs` 목록 아래 "이 조건으로 새 공고 알림 받기"(로그인한 구직자 + 조건 있음일 때만 — 비로그인 캐시 HTML 은 그대로), `/my/alerts`(요약·상태·빈도·끄기·다시 켜기(수신 동의 다시)·삭제), 마이페이지 링크,
      해지 `/alerts/u/:token`(GET 은 바꾸지 않음 → POST 버튼, "내 모든 알림 끄기", RFC 8058 한 번 클릭 POST — `sameOrigin` 예외는 그 경로 하나, 동의 확인 예외), 관리자 `/admin/system` 에 개수만.
      **보내기:** 예약 작업 단계 `sendAlerts` — SCHEDULE 24칸이 모두 차 있어 **가벼운 단계 뒤에 같은 실행으로 붙임**(`SHARED_SLOTS`: 00 UTC=09 KST report 뒤, 04·10 UTC dropOldRows 뒤, 06 UTC purgeVerificationDocs 뒤; 앞 단계 동작 그대로, 실행기는 단계마다 로그 한 줄·집계 한 번).
      매일 = 다음 09:00 KST, 매주 = 다음 월요일 09:00 KST, 21:00~08:00 KST·점검 모드에는 보내지 않음. 한 번에 `ALERT_SEND_PER_RUN`(기본 8, 최대 10), 메일 몫 `ALERT_MAIL_SITE_DAY`(기본 40)를 보내기 전에 잡고 모자라면 그만큼만,
      새 공고 없음 → 메일 없이 차례만, 보낸 뒤에 기록, 실패 5번 연속 → 자동으로 꺼짐, 정리(탈퇴 계정의 알림·12개월 안 쓴 알림·180일 지난 토큰). 메일(한·중): 조건 요약, 최대 10건 + "외 N건" `/jobs?…`, 받는 이유, 관리·해지 링크,
      운영자 줄(【확인 필요】 면 뺌), `List-Unsubscribe`·`List-Unsubscribe-Post` 머리글(`lib/email.ts` 의 `Mail` 에 선택 항목 `headers` 를 더함 — 유일한 email.ts 변경, 테스트).
      새 변수 `ALERT_MAIL_SITE_DAY`·`ALERT_SEND_PER_RUN`(wrangler.jsonc 두 곳). 공통 문구 정리: 필터 이름·값 문구(`FILTER_LABEL_KEYS`·`filterValueLabel`)를 views 에서 `lib/public-jobs` 로 옮김(동작 같음).
      테스트 66개 추가(`test/alerts.test.ts` 20 · `alert-send.test.ts` 26 · `alert-routes.test.ts` 17 · email 2 · maintenance 1) + 기계적 변경 2(시간표·실행기: 붙은 단계, quota 기본값 객체). 604 → 670.
      wrangler dev(4.166) + Chromium(Playwright)으로 가짜 기업·공고·구직자 → `/jobs` 에서 알림 만들기 → 새 공고(맞는 것 1·조건 다른 것 2) → `cdn-cgi/handler/scheduled?cron=maint:sendAlerts&time=…`(09:01 KST) → 콘솔 메일에 맞는 새 공고 1건만,
      정시 cron(00 UTC)에서 report 다음 sendAlerts 두 줄, 해지 링크 GET(바뀌지 않음) → POST(꺼짐 `unsubscribe`), curl 한 번 클릭 POST 빈 200, Origin 없는 `/all`·`/my/alerts` POST 403, 360px 가로 넘침 없음, 외부 요청 없음.
      **열린 법적 질문 (운영 전에 전문가 확인 필요):**
        1) 이 메일이 정보통신망법 제50조의 "영리목적의 광고성 정보" 인가 — 그렇다면 제목 앞 "(광고)", 수신 동의 2년마다 확인, 수신 거부 처리 결과 통지, 전송자 명칭·연락처 표시 등이 필요하다. 지금은 "(광고)" 를 붙이지 않았고(브리프),
           야간(21~08시) 미발송·명시적 수신 동의·해지 링크·전송자 표시(운영자 정보가 채워지면)만 보수적으로 지킨다. 개인정보처리방침 2항의 "광고 목적으로 쓰지 않습니다" 와 함께 판단해야 한다.
        2) 운영자가 공고를 고르지 않는 조건 알림이 직업정보제공사업의 범위 안인지(알선·소개로 보지 않는지) — 1350 문의(O-10) 때 함께 묻는다.
        3) 개인정보처리방침에 새 처리 목적(저장한 검색 조건·알림 메일)을 넣어야 한다 — `src/legal/` 은 이 작업에서 고치지 않았다. 아래 문장을 넣고 `PRIVACY_VERSION` 을 올린다(운영자).
           한국어 1항: "조건 알림을 만든 구직자: 저장한 검색 조건(필요한 중국어 수준·직무·업계·진출 단계·퇴직금 기준·보고 라인·근무지 중 고른 값), 알림 빈도, 알림 메일 수신 동의 일시, 알림 메일 발송 일시"
           한국어 2항: "구직자가 직접 저장한 검색 조건에 맞는 새 공고를 알림 메일로 보내는 일(이력서와 지원 기록은 쓰지 않으며, 운영자가 공고를 고르거나 추천하지 않습니다)"
           한국어 3항: "조건 알림: 구직자가 삭제하거나 탈퇴할 때까지. 12개월 동안 알림 메일이 나가지 않았거나 꺼져 있고 그동안 바꾸지 않은 알림은 자동으로 삭제합니다. 메일의 수신 거부 링크에 쓰는 값은 발송 후 180일이 지나면 삭제합니다."
           한국어 8항: "조건 알림 메일은 마이페이지의 "조건 알림" 화면이나 메일마다 있는 수신 거부 링크로 언제든지 끄거나 삭제할 수 있습니다."
           중국어(같은 자리): 1항 "创建条件提醒的求职者：保存的搜索条件（在所需中文水平、职能、行业、进入阶段、离职金标准、汇报对象、工作地点中所选的值）、提醒频率、同意接收提醒邮件的时间、提醒邮件的发送时间" ·
           2항 "按求职者本人保存的搜索条件，通过提醒邮件发送新发布的职位（不使用简历和应聘记录，运营方不挑选或推荐职位）" ·
           3항 "条件提醒：保存至求职者删除或注销为止。12个月内未发送过提醒邮件或处于关闭状态且期间未作修改的提醒将被自动删除。邮件中退订链接所用的值在发送180天后删除。" ·
           8항 "可随时在“我的页面”的“条件提醒”或通过每封邮件中的退订链接关闭或删除条件提醒邮件。"
      **남은 일:** 알림이 하루 32통(4회 × 8)을 넘게 쌓이면 밀린다 → 유료 플랜이면 `ALERT_RUN_MAX` 를 올리고 시각을 늘린다(하위 요청 계산 17-5 다시),
      Resend 하루 100통 안에서 `MAIL_SITE_DAY` + `ALERT_MAIL_SITE_DAY` + 인증코드 몫 나누기(DEPLOY.md 1장), 보낸 뒤 기록이 실패하면 같은 메일이 한 번 더 갈 수 있음(Resend `Idempotency-Key` 를 쓰려면 `sendMail` 을 더 고쳐야 함),
      해지 링크는 180일 뒤 만료(로그인해서 끌 수 있음), 사용 종료 항목의 "외 N건" `/jobs` 주소는 정규화 302 로 그 조건이 빠진 목록이 된다, 점검 모드 동안 해지 화면은 503(그동안 알림 메일도 멈춤),
      테스트 서버에 Resend 키가 없으면 모든 알림 발송이 실패해 5번 뒤 꺼진다(키를 넣은 뒤 켤 것), 실제 Resend 로 머리글이 Gmail 등에서 "구독 취소" 로 보이는지 확인(O-4 뒤), CPU 10ms 실측(T-12b)
- [x] T-16 2단계 인증 확장: 회원(구직자·기업 담당자) 선택 켜기(`/my/account/2fa`: 서버 대기 `totp_enrolments`(회원 + 지금 세션, 10분, 5회) → QR·키 → 번호 확인 →
      비밀키 저장·지금 세션 `mfa = 1`·다른 세션 삭제·복구 코드 8개 한 번 표시·알림 메일), 켠 회원의 로그인은 관리자와 같은 대기(`admin_totp_pending`) → `/login/totp` 번호 또는 복구 코드,
      2단계 인증을 켠 계정의 `mfa = 0` 세션은 로그인으로 보지 않음(`loadUser` 한 곳), 끄기(회원만, 번호·복구 코드 필요, 관리자 403), 재등록(1단계 지금 번호·복구 코드 → 새 키 → 새 번호로 확정, 확정 전까지 예전 키 유효),
      복구 코드 새로 만들기(번호 필요), 관리자 최초 등록 뒤 복구 코드 화면("저장했습니다 → 계속"), 복구 코드(10자·31자 알파벳·`SESSION_PEPPER`+회원 id 해시·한 문장으로 한 번만),
      로그인한 상태의 확인은 회원별 15분 5번(`users.totp_fail_*`), 관리자 초기화 `/admin/users/2fa-reset`(사유 10자 이상 → 확인 → `admin_actions` 기록·세션 삭제·알림, 관리자 계정 제외),
      정리 작업(만료 등록 대기·쓴/고아 복구 코드·기간 지난 관리자 기록). 마이그레이션 0013. ARCHITECTURE 3-1절, API.md.
      확인: `npm test` 700개, wrangler dev + Chromium 으로 회원 켜기 → 로그아웃 → 번호 로그인 → 복구 코드 로그인 → 끄기, 관리자 최초 등록(복구 코드)·재등록, 관리자의 회원 초기화,
      QR(OpenCV 로 읽은 값 = otpauth 주소), 360px 가로 스크롤 없음, 콘솔에 키·복구 코드 없음.
      **운영자 확인 필요:**
        1) (완료) `eraseUser` 가 복구 코드와 2단계 관련 값(totp_last_step·totp_enabled_at)도 함께 지운다.
        2) (완료, 판 2026-11-3) 개인정보처리방침에 넣은 문장:
           한국어 1항: "2단계 인증을 켠 회원: 인증 앱 등록 정보(암호화한 비밀키), 복구 코드의 해시값(코드 원문은 저장하지 않습니다), 2단계 인증을 켠 일시"
           한국어 2항: "계정 보호(2단계 인증), 회원이 요청한 2단계 인증 초기화와 그 기록"
           한국어 3항: "2단계 인증 정보: 회원이 끄거나 탈퇴할 때까지. 사용한 복구 코드는 다음 정리 작업에서 삭제합니다. 운영자가 2단계 인증을 초기화한 기록(처리한 운영자, 대상 회원, 사유, 일시)은 열람 기록과 같은 기간({access_log_keep}) 보관합니다."
           중국어 1항 "开启两步验证的会员：验证器应用绑定信息（加密后的密钥）、恢复码的哈希值（不保存恢复码原文）、开启两步验证的时间" ·
           2항 "保护账号（两步验证）、处理会员申请的两步验证重置及其记录" ·
           3항 "两步验证信息：保存至会员关闭或注销为止。已使用的恢复码在下一次清理作业中删除。运营方重置两步验证的记录（处理的运营人员、对象会员、原因、时间）与查看记录保存相同期限（{access_log_keep}）。"
      **남은 일:** 로그인 2단계는 대기마다 5번이고 인증코드를 다시 받으면 새 대기가 생긴다(메일함을 가진 공격자는 1분에 5번 시도 가능 — 회원별 로그인 실패 한도를 둘지 판단),
      관리자 초기화의 본인 확인 절차(전화·신분 확인 방법)는 운영 규칙으로 정할 일, 복구 코드 로그인 뒤에는 유형 안내(`LoginRoleNotice`)를 보이지 않는다, `admin_actions` 를 보는 화면은 없다(DB 로만),
      알림 메일은 Resend 키가 없는 테스트 서버에서 나가지 않는다(로그인도 안 되므로 같음)
- [x] T-17 사용량 한도와 조건 알림 켜기/끄기를 관리자 화면에서 설정 (다시 배포 없이). `site_settings` 의 새 키 `limits`(JSON: 한도 8칸 + `alerts_enabled`)와 `limits.log`(최근 20줄) — 마이그레이션 없음.
      `lib/limits.ts`(기본값 DEFAULT_LIMITS 를 quota.ts 에서 옮김 — quota 가 다시 내보냄, 범위 LIMIT_SPEC, `resolveLimits` = 칸마다 관리자 설정(범위 안일 때) → 변수(예전 규칙) → 기본값, DB 의 범위 밖 값은 무시,
      `alertsPaused` = 끔 · 알림 메일 한도 0 · 처리 수 0, 폼 검사(정수·범위·기업 몫 ≤ 사이트 몫), 저장 계획(바꾼 칸만 관리자 값), 기본값으로 되돌리기), `quota.loadLimits`(설정 한 행, 캐시 없음).
      범위: 번역 사이트 0~5000 · 기업 0~5000(≤ 사이트) · 엔진 비교 0~1000(≤ 사이트) · 기업 메일 사이트 0~5000 · 기업 0~5000(≤ 사이트) · 초안 1~100 · 알림 메일 0~100 · 알림 처리 수 0~10 (이유 ARCHITECTURE 15-1).
      **화면** `/admin/settings` "사용량 한도"·"조건 알림"(칸마다 범위·이유·출처 기본값/설정 파일/관리자 설정, 무료 플랜 안내 + 기업 메일 + 알림 메일 > 70 경고, 마지막 변경 누가·언제, 최근 변경 5줄)
      → 확인 화면(지금 → 바꾼 뒤 + 출처, 결과: 오늘 사용량에 닿으면 "한국 시간 내일 0시까지 더 쓸 수 없음", 0 = 끔, 알림 멈춤/다시 시작, "확인했습니다", 숨은 `base`) → 저장. `/admin/settings*` 모든 응답 no-store.
      `/admin/system` 에 지금 적용되는 값·출처·알림 발송 상태, `/admin`·`/admin/system` 의 사용량 줄도 지금 값.
      **알림 멈춤:** 예약 작업은 설정을 읽은 뒤 보내지 않고 알림을 바꾸지 않음(차례·확인 기준·실패 수 그대로, 멈춘 동안 12개월 미사용 알림 삭제도 건너뜀) → 다시 켜면 멈춘 동안의 공고도 다음 메일(최신 10건 + 외 N건).
      로그인한 구직자 `/jobs`(조건 있음)는 칸 대신 한 줄 안내, `/my/alerts` 는 안내 + 관리 그대로, `POST /my/alerts` 400, 해지 링크 그대로. 비로그인 `/jobs` HTML 은 그대로(테스트로 바이트 비교).
      **D1 읽기:** 알림 단계는 보일 필터와 한 문장(`db/settings.getSettings`)으로 읽어 하위 요청 수가 T-17 전과 같다(8 + 3n). 몫을 잡는 경로 +1, 불합격 묶음은 묶음당 +1, 비로그인 캐시 화면 0 (표: ARCHITECTURE 15-1).
      테스트: `test/limits.test.ts`(33), `test/limits-routes.test.ts`(15), `test/alert-send.test.ts` 에 T-17 블록(12) 추가 — 기존 테스트는 고치지 않음(760).
      확인: wrangler dev + Chromium 으로 한도 변경 → 확인 화면 → `/admin/system`, 알림 끄기 → 구직자 `/jobs`·`/my/alerts` → 다시 켜기 → 알림 만들기, 되돌리기, 360px 가로 스크롤 없음, 외부 요청 없음.
      **남은 일·운영자 판단:** 처리 수 10 이면 06 UTC 실행의 하위 요청이 47(한도 50, 여유 45 초과 — 8 이하 권장), 변수 범위(0~1,000,000)는 화면 범위보다 넓다(이미 배포된 값을 바꾸지 않으려고),
      기업 몫 ≤ 사이트 몫은 저장 때만 검사(변수를 나중에 바꾸면 어긋날 수 있으나 사이트 몫이 먼저 막음), 기본값(기업 메일 1000)은 무료 플랜 경고가 늘 보임 — 무료 플랜 동안 화면에서 40 + 30 으로 낮추기를 권함.
- [x] T-18 시연 계정 (테스트 서버·로컬 전용, docs/ARCHITECTURE.md 18절). 운영자 요청: 테스트 서버를 여러 사람이 역할별로 둘러볼 수 있게.
      `lib/demo.ts`(켜는 조건·계정 목록) · `lib/demo-data.ts`(가짜 기업 5·공고 17·이력서 5·지원 9) · `lib/demo-seed.ts`(규칙 함수로 상태를 정해 넣기·되돌리기, 시연 로그인) ·
      `db/demo.ts` · `POST /login/demo` · 로그인 화면의 시연 계정 칸 · `DEMO_LOGIN` 변수(테스트 "on", 운영 "off") · 배포 전 점검·`/admin/system` 항목 · 시연 주소로는 메일을 보내지 않음 ·
      시연 계정 탈퇴 막기. 운영(production)에서는 설정과 상관없이 꺼져 있다 — `test/demo-routes.test.ts` 가 확인한다. 테스트: `test/demo.test.ts`, `test/demo-routes.test.ts`.
      **하지 않은 것(운영자와 정할 것):** 시연 운영자 계정 — 관리자의 쓰기·열람마다 "대상이 시연 데이터인가" 검사를 `authz.ts` 에 넣어야 해서 따로 정한다.
- [x] T-19 표준 스택 전환: Cloudflare Workers(D1 + R2 + cron + Cache API) → 운영자 PC 의 **Node.js 26 + PostgreSQL 16 + 로컬 폴더**, Cloudflare Tunnel 뒤 (운영자 결정: 서버 하나 = recruit.kimbbob.xyz, `APP_ENV=test`).
      **실행:** `src/server.ts`(@hono/node-server, 127.0.0.1:PORT 만, 본문 12MB 제한, public/ 정적 파일, SIGINT·SIGTERM·SIGBREAK 정상 종료, 디버거 켜져 있으면 dev 말고는 시작 안 함), `.env`(`node --env-file`), esbuild → `dist/server.mjs`·`dist/maint.mjs`.
      **DB:** `src/db/pg.ts`(D1 모양 어댑터: `?`→`$n`+숫자 형, batch = SERIALIZABLE 트랜잭션, 40001·40P01·23505 다시 실행, SELECT changes 0, bigint → 숫자), `migrations/pg/0001_init.sql`(SQLite 0001~0013 의 최종 모양, COLLATE "C", BIGINT),
      `npm run db:migrate`(schema_migrations·지문·잠금). SQL 고친 곳 6곳 (DB-PORTING 2장). 동시성 표와 실제 PostgreSQL 병렬 시험 (DB-PORTING 4장, `test/pg-concurrency.test.ts`).
      **파일:** `src/lib/storage.ts`(R2 와 같은 put·get·delete·list, DATA_DIR\files, 키 검사·임시 파일 → 이름 바꾸기, S3 를 붙일 수 있는 FileStore 모양). 암호화·AAD 는 그대로.
      **예약 작업:** `src/lib/scheduler.ts`(매시 정각, 같은 SCHEDULE, 앞 실행이 돌면 건너뜀, 권고 잠금, `maint.last_run` 기록), 수동 실행 `npm run maint -- <단계>`(HTTP 경로 없음).
      **캐시:** `page-cache.ts` → 서버 메모리(MemoryPageCache, 같은 키·60초·비로그인만, 500개·512KB·32MB), `env.PAGE_CACHE` 가 없으면(테스트) 캐시 없음.
      **뺀 것:** Workers AI 엔진, `@cloudflare/workers-types`, Worker `scheduled`, `wrangler.jsonc`, `deploy-test.bat`·`backup-prod.bat`, `scripts/deploy.mjs`·`restore-decrypt.mjs`, `.dev.vars.example`(→ `.env.example`), 예전 `start.bat`(→ 새 start.bat).
      **/admin/system:** 바인딩 점검 대신 DB 연결·마이그레이션·파일/백업 폴더 쓰기·디스크 여유·예약 작업 마지막 실행(`lib/system-check.ts`), 비밀값 표에 DATABASE_URL·BACKUP_PASSPHRASE(값 없음).
      **백업:** `npm run backup`(pg_dump -Fc + 첨부파일 → AES-256-GCM + scrypt 한 파일 `recruit-<날짜>.enc`, 평문 없음), `npm run restore -- <파일>`(폴더 + RESTORE-STEPS.txt), 선택 자동 백업(BACKUP_AUTO).
      **가져오기:** `npm run import:cloudflare [-- --dry-run]` (wrangler d1 export → node:sqlite → 한 트랜잭션·행마다 저장점·ON CONFLICT(기본 키) DO NOTHING, 유일 제약 충돌은 되돌림, ENC_KEY 확인, 파일은 wrangler r2 object get).
      **한도:** `ALERT_SEND_PER_RUN` 최대 10 → 50 (Workers 하위 요청 50개 때문이었다. 기본 8·하루 알림 메일 한도는 그대로). 정리 작업 CAPS·BUDGET 은 안전장치로 그대로 (ARCHITECTURE 14-2).
      **테스트:** PGlite(`test/pg-test-db.ts`, 서버와 같은 createDb) 로 전체. 새 시험: pg-adapter · pg-schema · pg-concurrency(PG_TEST_URL) · storage · scheduler · page-cache-memory · server · import(+가짜 wrangler) · backup.
      **확인한 것 (개발 PC, PostgreSQL 16.15 · Node 26.13.1 · Chromium):** typecheck, 전체 시험, `npm run db:migrate`(recruit 계정·scram 비밀번호), `npm run build && npm start`, 가입·동의·기업 등록·서류·공고·한국어 직접 입력·승인·게재,
      이력서(PDF 첨부)·지원·기업이 지원서 열기·첨부 내려받기(같은 바이트, 디스크에는 RF1 암호문), 관리자 로그인 + TOTP 등록·복구 코드, 기업 승인, `/admin/system`(새 점검 6줄 모두 정상), 정각 예약 작업 실행,
      `npm run maint`, `npm run backup` → `npm run restore` → `pg_restore` 로 새 DB, 서버가 127.0.0.1:8787 하나만 듣는 것, 가짜 wrangler + 실제 PostgreSQL 로 가져오기 명령 전체.
      **확인하지 못한 것:** 실제 Cloudflare 계정에서 `wrangler d1 export`·`r2 object get`(인자는 wrangler 4.166 의 도움말로만 확인), Windows 경로·PowerShell 명령·`start.bat`·서비스 관리 프로그램 칸 이름,
      `fs.statfs` 의 Windows 디스크 여유, Windows 의 SIGTERM(서비스 관리 프로그램이 어떻게 끄는지), Cloudflare Tunnel 뒤의 Host·Origin·Secure 쿠키, 주소 전환(T-20), Resend 실제 발송, Claude/Gemini 실호출,
      http://127.0.0.1 에서 `APP_ENV=test` 의 Secure 쿠키 로그인.
      **바뀐 동작:** 4장 동시 요청이 D1 처럼 차례대로 처리됨(READ COMMITTED 였다면 깨졌을 한도 6곳), 공개 화면 캐시는 데이터센터별이 아니라 서버 하나, `/favicon.ico` 등 정적 파일도 앞단에서, 화면 문구 중 wrangler·Cloudflare 를 말하던 줄(시스템 점검·한도 설명), 정리 작업 하루 보고 메일의 마지막 줄.
## 운영자 설정 (사람이 하는 일 — 순서와 방법은 docs/DEPLOY.md)
- [ ] O-1 GitHub 저장소에 이 폴더 올리기 (`predeploy:prod` 는 main 브랜치·저장하지 않은 변경 없음을 확인한다)
- [ ] O-2 (T-19) PC 준비: PostgreSQL 16 에 `recruit` 계정·DB, `.env`(예전 테스트 서버의 ENC_KEY·SESSION_PEPPER, Resend 키) — DEPLOY.md 2·3장
- [ ] O-3 (T-19) 처음 설치·시험 실행: `npm ci` → `npm run db:migrate` → `npm run build` → `npm start` → `/api/health` — DEPLOY.md 4장
- [ ] O-4 (T-19) 서비스 관리 프로그램 등록 (빌드·시작 전 명령·시작 명령·포트 8787·서브도메인 recruit·디버거 끔) — DEPLOY.md 5장
- [ ] O-5 (T-19) 예전 테스트 서버 데이터 가져오기: `npm run import:cloudflare -- --dry-run` → 실제 → 확인 — DEPLOY.md 6장
- [ ] O-6 Cloudflare Access 로 recruit.kimbbob.xyz 를 운영자만 접속하게 잠그기 (터널 주소에도 그대로) — 권장
- [ ] O-7 복구 연습 한 번 (`npm run backup` → `npm run restore` → 다른 이름의 DB 에 pg_restore) — DEPLOY.md 7-5. 하면 DEPLOY.md 7-3 의 "해 보지 않은 절차" 표시를 지운다
- [ ] O-8 (나중) 운영 서버: 도메인, 직업정보제공사업 신고번호, 약관·방침 【확인 필요】 채움 + 전문가 검토(**국외 이전·보관 위치 문구: Cloudflare 에 데이터를 두지 않게 되었다 — T-20**), Resend 운영 도메인, 운영용 새 ENC_KEY, `predeploy:prod` 통과 — DEPLOY.md 11장
- [ ] O-9 (나중) 공공데이터포털 국세청 사업자 상태조회 키 발급 (T-04c), Gemini 키(선택)
- [ ] O-10 (나중) 고용노동부 1350 문의 → 답에 따라 기능 플래그 결정 (켜기 전 조건: ARCHITECTURE 5장)
- [ ] O-11 (매주) `npm run backup` + PC 밖 사본 — DEPLOY.md 7-1·7-2 (자동 백업은 7-4 의 장단점을 읽고 정한다)
- [ ] T-20 (운영자, T-19 다음) 주소 전환과 Cloudflare 정리 — DEPLOY.md 8장 【실제 환경에서 미확인】:
      1) 가져오기(O-5) 직전·직후로 예전 서버의 쓰기를 멈추고 가져오기를 한 번 더 → 2) Worker `recruit-test` 의 Custom Domain `recruit.kimbbob.xyz` 지우기(Worker 는 남김)
      → 3) 서비스 관리 프로그램의 터널 호스트 `recruit.kimbbob.xyz` → `http://127.0.0.1:8787` → 4) 바깥(휴대폰 LTE)에서 `/api/health`·로그인 메일·`/admin/system` 확인
      → 5) 며칠 뒤: 예전 서버 마지막 백업 → Worker·D1 `recruit-test`·R2 `recruit-test-files` 삭제 → `npx wrangler logout` → `npm uninstall wrangler`(devDependency, 가져오기에만 썼다)
      → 6) (반영함, 처리방침 판 2026-11-4) 개인정보처리방침 6항과 동의 문구 `consent.privacy.overseas` 를 새 구성에 맞게 고쳤다: 데이터·파일은 운영자가 한국에서 관리하는 서버, Cloudflare 는 접속 연결(전송 중계), Resend 는 메일. 자동 번역 사업자에서 Cloudflare 를 뺐다. 기존 회원은 다음 로그인 때 다시 동의한다. 이 표현이 위탁·국외 이전 고지로 충분한지는 전문가 검토 목록에 둔다.

## 개발
- [ ] T-05b 현지화 엔진 실호출 확인 (운영자가 키를 넣은 뒤): `/admin/localize-test` 로 claude·gemini 각각 호출해 (T-19 에서 workers_ai 는 뺐다)
      응답 모양·소요 시간(25초 안인지)·JSON 준수·숫자 보존을 확인하고, 기본 모델(`DEFAULT_*_MODEL`)이 맞는지 정한다.
      Gemini `thinkingLevel`, Workers AI 모델의 출력 모양(`choices` / `response`)과 `max_tokens` 인식 여부, Claude `anthropic-version` 을 새 버전(2026-10-21)으로 올릴지 함께 본다
- [ ] T-06c 공개 화면 보완: 생산직 플래그를 켤 때 목록 질의 계획 다시 확인(`job_family IN (...)` 이면 정렬용 임시 B-tree 가 전체 게재 공고를 읽을 수 있음),
      공고가 수천 건을 넘으면 필터별 인덱스 필요 여부 확인(D1 대시보드의 rows read), 캐시를 우회하는 임의 검색 조건(홈 `/?x=`) 처리,
      마감·차단 직후 캐시 즉시 지우기(지금은 최대 60초 남음 — T-19 부터 캐시가 서버 메모리라 `MemoryPageCache.clear()` 로 지울 수 있다)
- [ ] T-04c 국세청 사업자 상태조회 (공공데이터포털 키 발급 후)
- [ ] T-12b 정리 작업 남은 일: 탈퇴 계정(`users.status = 'deleted'`) 행 삭제 — jobs.created_by·access_log.actor_id·application_events.actor_id·consents.user_id 가 외래키로 가리켜 지금은 지우지 않는다
      (가리키는 행이 모두 기간이 지나 지워진 뒤에 지우거나, 가리키는 컬럼을 NULL 로 바꾸는 마이그레이션이 필요). R2 삭제에 실패한 `vdocs/` 객체 정리(지금은 `rfiles/` 만 고아 정리).
      처리량이 상한(하루 내용 삭제 50건 등)을 넘으면 상한 조정 (T-19: CPU 10ms 한도는 없어졌다 — 상한은 안전장치로 남겼다)
- [ ] T-14 (플래그 뒤) 이력서 중국어 요약: 경력·기술 항목만 번역 → 구직자 승인(`summary_approved_at`) → 기업 화면에 원문과 나란히 표시,
      본사 공유(받는 사람은 이메일 인증코드로 확인, 7일 만료) → `summary_shared`
- [ ] T-15 (플래그 뒤) 헤드헌터: 업체 등록·검증, 공고 등록 시 실제 구인 기업 지정, 지원 화면에 받는 곳 표시

## 2차 (지금 만들지 않는다)
소셜·QR 로그인(카카오 → 위챗 순. `user_identities(user_id, provider, provider_uid)` 테이블을 추가해 이메일 계정에 연결한다. Google 은 중국에서 차단되므로 넣지 않는다),

**다음 버전 검토(운영자 메모, 2026-11):** Outlier·Braintrust 처럼 "사람을 먼저 모으고(프로필·검증) 일을 연결하는" 방식은 지금 버전을 연 뒤 다음 버전에서 검토한다.
플랫폼이 사람을 심사·추천·연결하거나 보수를 지급하면 직업소개(등록 필요)·근로자공급에 해당할 수 있으므로, 먼저 법적 형태(유료직업소개사업 등록 요건)부터 확인한다.
지금 버전에 가져오는 것은 화면 구성뿐이다: 첫 화면의 단계 안내·차별점·자주 묻는 질문 (T-06b).
플랫폼 내 번역 메시지, 면접 일정, 구직자 공개 프로필·인재 검색, 카카오·위챗 로그인과 알림, 결제(PG), 응답률 공개, 채용 브랜딩 페이지
