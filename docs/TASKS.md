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
      서명으로 묶을지 운영자 판단), 기업당 하루 메일 수 한도(지금은 지원당 면접 3번·요청당 불합격 10건만), 메일 API 가 느릴 때 10건 차례 발송의 처리 시간(무료 플랜 한도) 실측,
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
- [ ] T-10 조건 알림: 필터 저장, 일간·주간 메일(제목 "조건에 맞는 새 공고"). 무료 플랜 CPU 한도를 넘지 않게 한 번에 보내는 수를 제한
- [ ] T-04c 국세청 사업자 상태조회 (공공데이터포털 키 발급 후)
- [ ] T-12b 정리 작업 남은 일: 탈퇴 계정(`users.status = 'deleted'`) 행 삭제 — jobs.created_by·access_log.actor_id·application_events.actor_id·consents.user_id 가 외래키로 가리켜 지금은 지우지 않는다
      (가리키는 행이 모두 기간이 지나 지워진 뒤에 지우거나, 가리키는 컬럼을 NULL 로 바꾸는 마이그레이션이 필요). R2 삭제에 실패한 `vdocs/` 객체 정리(지금은 `rfiles/` 만 고아 정리).
      CPU 10ms 한도 실측(배포 뒤 대시보드). 처리량이 상한(하루 내용 삭제 50건 등)을 넘으면 상한 조정
- [ ] T-13 운영 환경: `wrangler.jsonc` 에 `env.production`(별도 D1·R2·도메인), 주 1회 암호화 백업, 배포 절차 문서
- [ ] T-14 (플래그 뒤) 이력서 중국어 요약: 경력·기술 항목만 번역 → 구직자 승인(`summary_approved_at`) → 기업 화면에 원문과 나란히 표시,
      본사 공유(받는 사람은 이메일 인증코드로 확인, 7일 만료) → `summary_shared`
- [ ] T-15 (플래그 뒤) 헤드헌터: 업체 등록·검증, 공고 등록 시 실제 구인 기업 지정, 지원 화면에 받는 곳 표시

## 2차 (지금 만들지 않는다)
소셜·QR 로그인(카카오 → 위챗 순. `user_identities(user_id, provider, provider_uid)` 테이블을 추가해 이메일 계정에 연결한다. Google 은 중국에서 차단되므로 넣지 않는다),

**다음 버전 검토(운영자 메모, 2026-11):** Outlier·Braintrust 처럼 "사람을 먼저 모으고(프로필·검증) 일을 연결하는" 방식은 지금 버전을 연 뒤 다음 버전에서 검토한다.
플랫폼이 사람을 심사·추천·연결하거나 보수를 지급하면 직업소개(등록 필요)·근로자공급에 해당할 수 있으므로, 먼저 법적 형태(유료직업소개사업 등록 요건)부터 확인한다.
지금 버전에 가져오는 것은 화면 구성뿐이다: 첫 화면의 단계 안내·차별점·자주 묻는 질문 (T-06b).
플랫폼 내 번역 메시지, 면접 일정, 구직자 공개 프로필·인재 검색, 카카오·위챗 로그인과 알림, 결제(PG), 응답률 공개, 채용 브랜딩 페이지
