# 경로 목록

화면은 서버 렌더링 + HTML 폼이다. `✅` 는 구현됨, 나머지는 docs/TASKS.md 의 해당 작업에서 만든다.
모든 POST 는 같은 출처에서 온 요청만 받는다(`sameOrigin`) — **예외는 하나**: 조건 알림 메일의 RFC 8058 한 번 클릭 해지 `POST /alerts/u/<토큰>`(T-10, 아래). `/biz/jobs/:id/applicants*`·`/biz/applications*`·`/admin/applications*`·`/admin/access-log` 는 모든 응답(로그인 리다이렉트·403 포함)이 `private, no-store` 이고 HEAD 는 405 다(T-09a). `/consent`·`/my/account*`(2단계 인증 화면 포함)·`/login/totp`·`/admin/users/*` 의 모든 응답도 `private, no-store` 다(T-11·T-16). `/my/resumes*`·`/my/applications*`·`/jobs/:id/apply` 는 구직자만(비로그인 → /login, 기업·헤드헌터·관리자 403, 남의 이력서·지원 id 는 404), 모든 응답이 `Cache-Control: private, no-store`. "권한" 칸의 판단은 `authz.ts`·`requireRole` 을 쓴다.

예약 작업(T-12, 공고 자동 마감·보관 기한 삭제·정리, T-10 조건 알림 메일)은 cron(`scheduled`)으로만 실행되며 HTTP 경로가 없다 (docs/ARCHITECTURE.md 14·17절). 기간은 관리자 보관 기간 설정(`/admin/settings`, T-12c)을 따른다.

남용 방지 한도(T-05c, docs/ARCHITECTURE.md 15절): 아래 "한도" 라고 적은 경로는 하루 한도(한국 시간)를 먼저 잡는다 — 기업(또는 관리자) 몫 → 사이트 몫. 한도에 걸린 응답에만 안내가 보인다. 한도 숫자는 vars `LOCALIZE_PER_COMPANY_DAY` · `LOCALIZE_SITE_DAY` · `ADMIN_LOCALIZE_TEST_DAY` · `MAIL_PER_COMPANY_DAY` · `MAIL_SITE_DAY` · `DRAFT_JOBS_PER_COMPANY` (+ T-10 예약 작업의 알림 메일 `ALERT_MAIL_SITE_DAY`·`ALERT_SEND_PER_RUN`, ARCHITECTURE 17절).

## 공통
| 경로 | 설명 | 권한 | 상태 |
|---|---|---|---|
| GET / | 홈 (소개 + 최신 공개 공고 5건). 비로그인은 60초 캐시. `?bye=1`(탈퇴 직후)은 한 줄 안내를 그리고 캐시하지 않음(`private, no-store`) | 누구나 | ✅ |
| GET /login · POST /login/request · POST /login/verify | 이메일 인증코드 로그인·가입 | 누구나 | ✅ |
| POST /logout | 로그아웃 | 로그인 | ✅ |
| GET·POST /login/totp | 로그인 2단계 (ARCHITECTURE 3-1). 관리자 필수(최초에는 인증 앱 등록 → 번호 확인 → 복구 코드 8개를 이 응답에서 한 번 표시, "저장했습니다 → 계속" → `/admin`), 2단계 인증을 켠 회원(T-16). 등록된 계정은 `code` 한 칸에 인증 앱 6자리 번호 또는 복구 코드(대소문자·공백·하이픈 무시). 번호·복구 코드가 대기의 5회를 같이 쓰고, 5회·10분이면 `/login`. 통과: 관리자 → `/admin`, 회원 → 고른 유형이 다르면 유형 안내, 아니면 `/my`. 복구 코드로 통과하면 남은 개수 + 재등록 안내 화면과 알림 메일. 모든 응답 `private, no-store` | 인증코드를 통과한 관리자·2단계 인증을 켠 회원 (대기 쿠키 `atp`) | ✅ T-03·T-16 |
| GET /lang/:l | 언어 전환 (ko/zh) | 누구나 | ✅ |
| GET /my | 역할별 첫 화면 (구직자: 이력서·지원 현황 링크, 기업·헤드헌터 → /biz, 관리자 → /admin) | 로그인 | ✅ |
| GET /biz | 기업 첫 화면 (소속 없음: 받은 초대 + 기업 등록 폼 / 소속 있음: 검증 상태·남은 할 일·새 지원 요약 "새 지원 M건 · 전체 N건"(새 지원자 알림 메일이 이 주소로 연결)). 헤드헌터는 임시 화면 | company, headhunter | ✅ |
| GET /api/health | 상태 확인 `{ ok: true, env }` 만 (설정 점검 결과는 내지 않는다 — `/admin/system`) | 누구나 | ✅ |
| (모든 경로) 점검 모드 | `MAINTENANCE = "on"` 이면 관리자 세션·`/api/health`·`/login*`·`/logout`·`/lang/*`·`/admin*`·정적 파일 말고 모두 503 점검 안내(한·중, `Retry-After`, `private, no-store`). 라우트·공개 화면 캐시보다 먼저 (ARCHITECTURE 6-2) | — | ✅ T-13 |
| (없는 경로) · 권한 없음 | 404 · 403 화면 (공통 레이아웃, 한국어·중국어) | 누구나 | ✅ |
| GET /terms · /privacy | 이용약관·개인정보처리방침 (`src/legal/`, 현재 언어). 비로그인은 60초 캐시. 동의 없이도 열림. `/privacy` 의 보관 기간 숫자는 지금 보관 기간 설정으로 채운다(`legal/render.renderLegal`, 캐시에 없을 때 설정 한 행 읽기 — 저장 뒤 비로그인 화면은 최대 60초 예전 숫자, T-12c) | 누구나 | ✅ T-11·T-12c |
| (모든 경로) 동의 확인 | 로그인한 회원(관리자 제외)이 지금 판의 약관·개인정보 동의가 없으면 GET·HEAD → `/consent?next=<경로>`, 그 밖은 403. 개인정보 판은 보관 기간 설정의 rev 로 정해진다(`PRIVACY_VERSION` 또는 `PRIVACY_VERSION+r<n>`, 요청마다 설정 한 행 읽기, T-12c). 비로그인·예외 주소(`/consent` `/terms` `/privacy` `/logout` `/login*` `/lang/*` `/my/account*` `/api/health`)·정적 파일은 확인하지 않음. `private, no-store` (ARCHITECTURE 13절) | — | ✅ T-11 |
| GET /consent | 동의 화면: 빠진 종류의 체크 칸만(미리 체크 없음), 이미 동의한 종류는 안내, 수집 항목·목적·보유 기간(지금 보관 기간 설정의 숫자)·국외 보관 요약, 탈퇴·로그아웃 안내, 숨은 `next`. 빠진 것이 없으면 `safeNext(next)` 로 302. 비로그인 → /login, 관리자 → /admin | 로그인 (관리자 제외) | ✅ T-11 |
| POST /consent | `terms=1`·`privacy=1`·`next` → 빠진 종류가 모두 체크돼야 함(아니면 400, 기록 없음) → 빠진 종류만 `consents` 에 기록 → 303 `safeNext(next)`(밖으로 나가는 주소·예외 주소는 `/my`) | 로그인 (관리자 제외) | ✅ T-11 |
| GET /my/account | 계정: 로그인 이메일·유형·동의 내역(판)·문서 링크·회원 탈퇴 입구. 관리자·다른 담당자가 있는 기업의 대표 담당자는 입구 대신 이유 | 로그인 | ✅ T-11 |
| GET /my/account/2fa | 2단계 인증: 상태·켠 시각·남은 복구 코드 수. 꺼져 있으면 켜기 안내, 켜져 있으면 재등록·복구 코드 새로 만들기·(회원만) 끄기 링크. 이 세션에서 등록 중이면 서버 대기의 새 키(QR·키)와 확인 칸. `?ok=off` 만 받는다 | 로그인 | ✅ T-16 |
| POST /my/account/2fa/start | 켜기 시작: 꺼진 계정만 → 등록 대기(회원 + 지금 세션, 10분, 5회) → 303 `/my/account/2fa`. 켜진 계정은 아무것도 하지 않고 303 | 로그인 | ✅ T-16 |
| POST /my/account/2fa/reenrol | 재등록 1단계: `code`(지금 번호 또는 복구 코드, 회원별 15분 5번) → 새 등록 대기 → 303. 틀리면 400(잠김도 400, 같은 화면). 예전 키는 확정 전까지 유효 | 2단계 인증을 켠 계정 | ✅ T-16 |
| POST /my/account/2fa/confirm | 켜기·재등록 확정: `code`(대기의 새 키로 만든 번호만 — 키는 폼으로 받지 않는다) → 비밀키 저장·지금 세션 `mfa = 1`·다른 세션 삭제·복구 코드 8개(이 응답에서 한 번 표시) + 알림 메일. 틀리면 400(대기 5회), 대기 없음·만료 400 | 로그인 | ✅ T-16 |
| POST /my/account/2fa/cancel | 이 세션의 등록 대기 삭제 → 303 | 로그인 | ✅ T-16 |
| POST /my/account/2fa/codes | 복구 코드 새로 만들기: `code`(지금 인증 앱 번호만, 회원별 15분 5번) → 예전 코드 무효, 8개를 이 응답에서 표시 + 알림 메일. 틀리면 400 | 2단계 인증을 켠 계정 | ✅ T-16 |
| GET·POST /my/account/2fa/off | 끄기: `code`(번호 또는 복구 코드, 회원별 15분 5번) → 비밀키·복구 코드·대기 삭제 + 알림 메일 → 303 `/my/account/2fa?ok=off`. 틀리면 400. 꺼진 계정 GET 은 `/my/account/2fa` 로. **관리자 403** | 2단계 인증을 켠 회원(관리자 제외) | ✅ T-16 |
| GET /my/account/delete | 탈퇴 확인 화면(지워지는 것·남는 것, 로그인 이메일 입력 칸). 막히는 계정은 계정 화면 | 로그인 | ✅ T-11 |
| POST /my/account/delete | `confirm`(로그인 이메일) 다르면 400(아무것도 안 바뀜) → `deleteAccount` → 막히면 400 + 계정 화면 → 세션 쿠키 삭제, 303 `/?bye=1`(홈에 한 줄 안내, 이 요청은 캐시 안 함) | 로그인 | ✅ T-11 |

## 구직자
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| GET /jobs | 공고 목록 (공개 조건: ARCHITECTURE 9장). T-10: 로그인한 구직자가 조건을 하나 이상 골랐을 때만 목록 아래에 조건 알림 만들기 칸(POST /my/alerts) — 비로그인 캐시 화면에는 없음. 필터 `chinese_level` `role_category` `industry` `entry_stage` `salary_basis` `report_line` `location` 중 관리자가 보이게 한 것만(기본: `chinese_level` `report_line` `location`, `/admin/settings`), `page`(20건씩, 최대 100). 직무·업계·근무지 값은 사용 중인 항목(`job_options`, `/admin/options`)만 받는다. 빈 칸·모르는 조건·숨긴 조건·사용 종료된 항목 값이 붙은 주소는 정규화 주소로 302. 비로그인은 60초 캐시 | 누구나 | ✅ |
| GET /jobs/:id | 공고 상세 (구조 항목·기업·지원 칸·기업 연락처). 지원 칸: 비로그인은 누구에게나 같은 "지원하기" 링크(캐시되는 화면에 사용자별 내용 없음), 로그인한 구직자는 지원했으면 "이미 지원했습니다", 기업·헤드헌터·관리자는 안내만(버튼 없음). 보이지 않는 공고는 404. 비로그인은 60초 캐시 | 누구나 | ✅ |
| GET /companies · /companies/:id | 기업 목록·기업 페이지 (검증된 기업만, "기업 제공 정보" 표시. 사업자번호·담당자·서류는 공개하지 않음) | 누구나 | ✅ |
| GET /my/resumes | 내 이력서 목록 (대표 먼저, 최대 5개). 줄마다 제목·한 줄 소개·수정일·첨부파일 이름·지원 가능 여부, 수정·복사·대표로 지정·삭제. 열 수 없는 이력서(복호화 실패)는 "열 수 없는 이력서" + 삭제만. 결과 표시는 `?ok=created\|saved\|copied\|copied_nofile\|default\|deleted`, `?err=limit` 뿐 | seeker 본인 | ✅ |
| GET·POST /my/resumes/new | 새 이력서 (multipart: 항목 + 첨부파일 `attachment` 1개, PDF·DOCX 5MB). 연락 이메일 기본값 = 계정 이메일. 첫 이력서는 대표. 5개면 `?err=limit` 로 302. 본문이 6MB 를 넘으면(`content-length`) 읽지 않고 413. 항목·파일 오류는 400 + 입력값 유지(파일은 다시 골라야 함) | seeker 본인 | ✅ |
| GET·POST /my/resumes/:id/edit | 수정 (`updated_at` 숨은 칸 = 화면을 연 때의 버전. 다르면 400 + 안내 + 입력값 유지). 첨부파일: 새 파일이면 교체, `remove_file=1` 이면 삭제, 아니면 유지. 예전 R2 객체는 DB 갱신이 성공한 뒤에 지운다 | seeker 본인 (`canEditResume`) | ✅ |
| GET /my/resumes/:id/file | 첨부파일 내려받기 (항상 attachment, 미리보기 없음, access_log). `serveResumeFile` 만 쓴다 | seeker 본인 (`canViewResume`) | ✅ |
| POST /my/resumes/:id/copy | 복사 ("제목 (복사)", 중국어 화면은 "(副本)"). 첨부파일은 새 R2 객체로 다시 암호화해 복사. 원본 파일이 없으면 첨부 없이 복사(`ok=copied_nofile`). 5개면 `?err=limit` | seeker 본인 | ✅ |
| POST /my/resumes/:id/default | 대표 이력서 지정 | seeker 본인 | ✅ |
| GET·POST /my/resumes/:id/delete | 삭제 확인 화면(제목, 낸 지원서는 영향 없음 안내) → 삭제. 대표를 지우면 가장 최근에 고친 것이 대표. 행을 지운 뒤 R2 객체를 지운다 | seeker 본인 | ✅ |
| GET /jobs/:id/apply | (T-12c: 국외 이전 동의 문구의 "공고 마감 후 N일" 은 지금 보관 기간 설정, 폼에 숨은 칸 `keep_days`) 지원 1단계: 이력서 고르기 (대표 기본 선택, 지원할 수 없는 이력서는 사유와 함께 고를 수 없음). `?resume=<id>` 이면 2단계: 그 이력서로 채운 폼(이번 지원에만 쓰임, 이름표 없음) + 첨부 "함께 보내기"(기본 체크) + 확인 상자(받는 곳·보내는 내용·운영자는 검토·추천·전달하지 않음·취소 시 삭제) + 국외 이전 동의 칸(`consentNeed`: 없음/선택/필수). 보이지 않는 공고 404, 이미 지원(취소 포함) → 그 지원으로 302, 지원할 수 있는 이력서가 없으면 이력서 안내, 남의 이력서 404, 지원 불가 이력서를 고르면 400. page-cache 없음 | seeker | ✅ |
| POST /jobs/:id/apply | 지원 제출 (`resume_id`, 이력서 항목, `include_file=1`, `consent=1`, `keep_days`). T-12c: 지원에 `keep_days` = MIN(숨은 칸(30~365 일 때만), 지금 설정)을 남기고, 국외 이전 동의 판은 `CROSS_BORDER_VERSION/k<keep_days>`. 순서: 공고·내 이력서 → 항목 검사(400 + 입력 유지) → 동의 필요 여부 → 미리 `applyBlocks` → 첨부 복사(새 R2 객체) → `applyBlocks` 다시 → `insertApplication`(거절·예외면 복사한 파일 삭제, 거절은 400 안내) → 기업 활성 담당자 최대 10명에게 `new_applicant` 메일(공고 제목·주소만, 실패해도 지원 유지) → `/my/applications/:id?ok=applied` (첨부를 읽지 못해 빼고 냈으면 `applied_nofile`). 중복은 기존 지원으로 302. 필수 동의 없음·내용 부족(첨부·경력 요약 둘 다 없음)은 400 | seeker | ✅ |
| GET /my/applications | 지원 현황 (최근 순, 최대 200): 공고 제목(지금 공개 중이면 링크), 기업명 또는 "기업명 비공개", 지원일, 상태(지원 완료·기업이 열람함·검토 중·면접 요청 받음·불합격·채용 종료·지원 취소함). 상태는 이벤트로만 바뀐다 | seeker | ✅ |
| GET /my/applications/:id | 내 지원 한 건 (`canViewApplication`): 상태·날짜·국외 이전 동의 여부·보낸 내용(기업이 보는 복사본 그대로)·첨부 링크. 취소한 지원·내용을 열 수 없는 지원은 안내 문구. "열람 기록"(T-09a): 본인 아닌 사람이 지원서·첨부를 연 시각과 역할(기업 채용 담당자·운영자)만, 최근 순. 이름·이메일·사유 없음, 취소한 지원에는 없음. 결과 표시 `?ok=applied\|applied_nofile\|withdrawn` | seeker 본인 | ✅ |
| GET /my/applications/:id/file | 지원서 첨부 내려받기 (attachment, access_log). `serveApplicationFile` 만 쓴다. 취소한 지원은 404 | seeker 본인 | ✅ |
| GET·POST /my/applications/:id/withdraw | 지원 취소 확인 화면(내용·첨부 즉시 삭제, 기업이 더 볼 수 없음, 같은 공고 재지원 불가) → 취소(`canWithdraw` → `withdrawApplication`: `withdrawn` 이벤트 + 상태 + 내용·파일 키 삭제 + 동의 철회, 그 뒤 R2 객체 삭제) → `/my/applications/:id?ok=withdrawn`. 끝난 지원·이미 취소한 지원은 400 | seeker 본인 | ✅ |
| GET /my/alerts | 조건 알림 목록 (최대 5개): 조건 요약(지금 항목 이름, 사용 종료 항목 표시, 관리자가 숨긴 조건은 "지금 적용되지 않음", 적용되는 조건이 없으면 "메일을 보내지 않음"), 상태·꺼진 이유, 빈도, 다음 확인 시각(한국 시간), 마지막 메일, "이 조건의 공고 보기", 빈도·끄기·다시 켜기·삭제 폼. `?ok=created\|saved\|paused\|resumed\|deleted`, `?err=consent\|frequency\|notfound`. `private, no-store` (ARCHITECTURE 17절) | seeker 본인 | ✅ T-10 |
| POST /my/alerts | 만들기 (`/jobs` 의 "이 조건으로 새 공고 알림 받기" 칸): 검색 조건(`/jobs` 와 같은 이름, 같은 파서로 다시 읽음) + `frequency`(daily·weekly) + `optin=1`(알림 메일 수신 동의, 시각·판 저장) → 303 `/my/alerts?ok=created`. 조건 없음·동의 없음·빈도 오류·5개·같은 조건은 400 + 안내(조건을 고른 `/jobs` 로 돌아가는 링크) | seeker | ✅ T-10 |
| POST /my/alerts/:id/frequency · /pause · /resume · /delete | 빈도 바꾸기(`frequency`, 다음 차례 다시 계산) · 끄기 · 다시 켜기(`optin=1` 필수 — 없으면 400, 실패 수 0, 꺼져 있던 동안의 공고는 보내지 않음) · 삭제(해지 토큰도 함께). 남의 알림·없는 id 는 `?err=notfound`, 아무것도 바뀌지 않음 | seeker 본인 | ✅ T-10 |
| GET /alerts/u/:token | 메일의 해지 링크: 로그인하지 않음, **아무것도 바꾸지 않음**(메일 검사기가 미리 연다). 그 알림의 조건 요약 + "이 알림 끄기"(POST) + "내 모든 알림 끄기"(POST `/all`). 이메일 등은 보이지 않음. 모르는·만료(180일)·모양이 다른 토큰은 일반 안내 404. 동의 확인 예외(다시 동의하지 않은 회원도 열림). `private, no-store` | 토큰 | ✅ T-10 |
| POST /alerts/u/:token | 그 알림 하나를 끈다(`paused_reason = unsubscribe`). 본문 `List-Unsubscribe=One-Click`(RFC 8058, 메일 프로그램 — 쿠키·Origin 없음)이면 빈 200(모르는 토큰도 같은 응답), 아니면(확인 화면의 버튼) 안내 화면(모르는 토큰 404). **`sameOrigin` 예외는 정확히 이 경로·이 메서드뿐**(`lib/alerts.isOneClickUnsubscribe`) | 토큰 | ✅ T-10 |
| POST /alerts/u/:token/all | 그 토큰 주인의 켜진 알림을 모두 끈다 → 안내(N개). 출처 검사를 받는다 | 토큰 | ✅ T-10 |

## 기업
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| POST /biz/company | 기업 등록 (대표 담당자 자동 지정. 이미 소속이 있으면 거부). GET 은 /biz 로 보냄 | company (소속 없음) | ✅ |
| GET·POST /biz/company/edit | 기업 정보 편집 (검증 뒤 기업명·사업자 형태·번호 잠금) | canManageCompany | ✅ |
| GET·POST /biz/company/docs | 검증 서류 목록·업로드 (R2 비공개, 기업당 5개) | canManageCompany | ✅ |
| GET /biz/docs/:id | 검증 서류 내려받기 (access_log) | canViewVerificationDoc | ✅ |
| GET /biz/members | 담당자·대기 초대 목록 (대표 담당자가 아니면 읽기만) | canManageCompany | ✅ |
| POST /biz/members/invite · /biz/members/:userId/remove · /biz/invites/:id/cancel | 담당자 초대(초대 메일 `company_invite` 발송, 실패해도 초대 유지)·내보내기·초대 취소. **한도**(T-05c): 메일을 실제로 보낼 때(검증된 기업)만 메일 몫을 잡고, 걸리면 메일 없이 `?ok=invited&mail=limit_company\|limit_site`(초대는 저장, "직접 알려 주세요" 안내) | canManageMembers (owner) | ✅ |
| POST /biz/invites/:id/accept | 초대 수락 (초대받은 이메일 본인, 소속 없을 때만) | company | ✅ |
| GET /biz/jobs · GET·POST /biz/jobs/new | 공고 목록(공고마다 "지원 N건 · 새 지원 M건" → 지원자 목록, 취소된 지원은 세지 않음) · 새 공고(중국어 원문 + 조건). 남의 공고는 404. **한도**(T-05c): 작성 중인 공고(게재 중·마감이 아닌 것)가 `DRAFT_JOBS_PER_COMPANY` 개면 400 + 입력 유지 + 안내 | 소속 기업 담당자 | ✅ |
| GET /biz/jobs/:id | 확인 화면: 원문 \| 한국어 초안 \| 대조본, 숫자 대조 경고, 게재 조건 목록 | canEditJob | ✅ |
| GET·POST /biz/jobs/:id/edit | 원문·조건 편집 (마감된 공고는 불가). 글을 고치면 승인이 풀리고 게재 중이면 게재 중단 | canEditJob | ✅ |
| POST /biz/jobs/:id/localize | 현지화 초안 + 대조본 생성 (`again=1` 이면 지난번 다음 엔진부터). 엔진이 없으면 수동 입력 안내. 순서: 엔진 없음 → 20초 간격 → **한도**(T-05c, 번역 몫: 기업 → 사이트, 걸리면 400 + 안내, 엔진 호출 없음, 수동 입력 칸은 그대로) → 엔진 | canEditJob | ✅ |
| POST /biz/jobs/:id/korean | 한국어 초안 직접 입력·수정 (대조본 지움, 다시 승인 필요) | canEditJob | ✅ |
| POST /biz/jobs/:id/approve | 한국어 초안 승인 (본 rev 일 때만) | canEditJob | ✅ |
| POST /biz/jobs/:id/publish | 게재 (`publishBlocks` 가 비어야 함) | canEditJob | ✅ |
| POST /biz/jobs/:id/close | 마감 (게재 중 → 마감, 다시 열기 없음) | canEditJob | ✅ |
| GET /biz/jobs/:id/delete | 쓰지 않은 초안 삭제 확인 화면 (되돌릴 수 없음 안내). 초안이고 게재된 적이 없고(`published_at` 없음) 지원이 없을 때만(`lib/jobs.draftDeletable`), 아니면 400 + 공고 화면에 안내. 공고 목록·공고 화면의 "삭제" 는 그런 초안에만 보인다 | canEditJob (남의 공고 404) | ✅ T-12c |
| POST /biz/jobs/:id/delete | 같은 검사 → `db/jobs.deleteUnusedDraft`(한 문장이 초안·게재 이력 없음·지원 없음·기업을 다시 확인) → 303 `/biz/jobs?ok=deleted`. 게재 중·마감·차단·예전 게재 공고는 400, 행 그대로 | canEditJob (남의 공고 404) | ✅ T-12c |
| GET /biz/jobs/:id/applicants | 지원자 목록: 지원 순서 번호·지원일·기업용 상태 이름·첨부 여부만 (**개인정보 없음**, 정렬·추천·메모·내보내기·상태 변경 없음). T-09b: 진행 중인 줄마다 불합격 통보용 체크 칸(본사 담당자에게 동의 없는 줄은 없음) + "선택한 지원자에게 불합격 통보", 면접 요청을 보낸 줄에 "면접 요청 N회", 결과 표시 `?ok=interview`, `?ok=rejected&sent=N&failed=M`. 취소된 지원은 링크 없는 "지원 취소됨", 본사 소속 담당자에게 동의 없는 지원은 링크 없는 안내. 보는 것은 기록하지 않음 | canEditJob (남의 공고 404) | ✅ T-09a·b |
| GET /biz/applications/:id | 지원서 열람: 이 기업 공고의 지원서가 아니면 404 → `openApplication` 한 번(access_log 한 줄, 처음 열면 `viewed` 이벤트로 상태 변경). 내용 = 구직자가 보낸 복사본 그대로 + 첨부 링크. 취소됨(삭제 안내)·국외 이전 동의 없음(403 안내)·열 수 없음은 기록 없이 안내. HEAD 405, 미리 가져오기 503 | canViewApplication | ✅ T-09a |
| GET /biz/applications/:id/file | 지원서 첨부 내려받기 (`downloadApplicationFile`: 권한 → access_log → attachment, 상태 변경 없음). 볼 수 없거나 첨부 없음 404. HEAD 405 | canViewApplication | ✅ T-09a |
| GET /biz/applications/:id (T-09b 추가) | 진행 중인 지원(새 지원·열람함·검토 중·면접 요청함)이면 아래에 "면접 요청 보내기" 칸(메시지 2000자, 남은 횟수 "N번 더 보낼 수 있습니다", 답장 주소 = 로그인한 담당자 본인 이메일)과 "불합격 통보" 입구(한 건으로 확인 화면). 횟수를 다 썼으면 안내만. 지원서는 이 요청에서 한 번만 연다 | canViewApplication | ✅ T-09b |
| POST /biz/applications/:id/interview/compose | 쓰기 화면 (미리 보기의 "고치기"). 공고 제목·지원 순서 번호·지원일·상태 + 폼(글 유지)만 — 지원서를 열지 않음(기록 없음), 개인정보 없음 | canViewApplication | ✅ T-09b |
| POST /biz/applications/:id/interview/preview | `message` → `readMessage`(비었거나 2000자 초과는 400 + 쓰기 화면, 글 유지) → `translateMessage`(엔진에는 메시지 글만) → 원문 \| 한국어 자동 번역 나란히 + "번역 없이 원문만 보내기" + 보내기/고치기. 엔진 없음·실패·원문과 같음이면 "원문만 보냅니다" 안내. 원문·번역은 숨은 칸으로 다음 단계에. **한도**(T-05c): 엔진이 있을 때만 번역 몫(공고 현지화와 같은 기업 몫 → 사이트)을 잡고, 걸리면 엔진 없이 원문만 + 한도 안내(200, 보내기는 됨) | canViewApplication (+ 진행 중, 3번 미만) | ✅ T-09b |
| POST /biz/applications/:id/interview/send | `message`·`translation`·`only_original` → 원문 다시 검사, 번역 정리(비었거나 원문만·원문과 같음·4배+200자 초과면 버림) → **한도**(T-05c, 메일 몫: 기업 → 사이트, 걸리면 400 + 글을 지닌 미리 보기 + 안내, 메일·기록 없음) → `sendInterviewRequest`(답장 주소 = 담당자 이메일) → 303 `/biz/jobs/:jobId/applicants?ok=interview`(지원서 화면으로 가지 않음 — 열람이 또 기록되므로). 끝난 지원·3번 초과·열 수 없음은 400 안내, 메일 실패는 400 + 글을 지닌 미리 보기, "메일은 보냈지만 기록되지 않음" 안내, 권한 없음 404 | canViewApplication (lib/applicant-mail) | ✅ T-09b |
| POST /biz/jobs/:id/applicants/reject/confirm | 고른 `id`(여러 개, 중복 제거) → 0개·10개 초과는 400 + 목록, 이 공고의 지원이 아닌 id 가 섞이면 404, 끝난 지원·(본사 담당자) 동의 없는 지원은 빼고 센다(모두 빠지면 400). 확인 화면: 보낼 수, 보낼 정해진 글 그대로(`rejectMail`, 한국어 — 중국어 화면은 같은 문구 키의 중국어 참고도), 되돌릴 수 없음·지원자 상태가 "불합격"·답장 주소 안내 | canEditJob + canViewApplication | ✅ T-09b |
| POST /biz/jobs/:id/applicants/reject/send | 확인과 같은 검사 → 한 건씩 차례로 (**한도**(T-05c): 한 통마다 메일 몫을 먼저 잡고, 처음 걸린 곳에서 멈춤 — 남은 건은 보내지도 기록하지도 않음) `sendRejection` → 303 `/biz/jobs/:id/applicants?ok=rejected&sent=N&failed=M`(숫자만, 한도로 멈췄으면 `&limited=K&pool=company\|site` — 목록에 "K건은 한도에 걸려 보내지 않음" + 한도 안내) | canEditJob + canViewApplication (lib/applicant-mail) | ✅ T-09b |

## 관리자
| 경로 | 설명 | 작업 |
|---|---|---|
| GET /admin | 처리할 일 개수 (검증 대기·검토 대기·신고). 검증 대기 기업 → /admin/companies, 검토 대기 공고 → /admin/jobs, 신고 목록은 T-09. "오늘 사용량"(T-05c): 사이트 전체 자동 번역 호출·기업 메일의 `쓴 수 / 한도`(한국 시간 오늘) | ✅ |
| GET /admin/companies · /admin/companies/:id | 기업 목록(검증 대기 먼저)·상세 (담당자 이메일, 서류, `verifyBlocks` 결과) | ✅ |
| POST /admin/companies/:id/verify | 기업 승인(`verifyBlocks` 가 비어야 함)·반려(사유 필수, `reject_docs` 체크 시 서류도 반려). 검증 대기 상태에서만 | ✅ |
| POST /admin/companies/:id/revoke | 승인 취소(사유 필수, `reject_docs` 체크 시 서류도 반려). 검증 완료 상태에서만. 기업은 반려 상태, 게재 중 공고는 `closed` | ✅ |
| GET /admin/docs/:id | 검증 서류 내려받기 (access_log) | ✅ |
| GET /admin/jobs · /admin/jobs/:id | 검토 대기(기술유출 필터)·차단 공고 목록·상세 (한국어·원문·대조본·사유) | ✅ |
| POST /admin/jobs/:id/clear-review · /block · /unblock | 검토 통과(본 rev 일 때만) · 차단(사유 필수) · 차단 해제(→ 미게재). 내용 수정·게재는 없다 | ✅ |
| GET·POST /admin/localize-test | 현지화 엔진 비교 (같은 글을 엔진별로, 초안·대조본·시간·오류). 저장하지 않음. **한도**(T-05c): 고른 엔진 수만큼 관리자 몫(`ADMIN_LOCALIZE_TEST_DAY`) → 사이트 번역 몫, 걸리면 400 + 안내(엔진 호출 없음) | ✅ |
| GET·POST /admin/settings | 사이트 설정: `/jobs` 검색 칸에 보일 필터 체크박스(`filters`, 여러 개). `FILTER_KEYS` 밖의 값은 버림, 모두 끄면 빈 목록 저장(`site_settings.public_job_filters`). 저장 후 `?ok=saved` 로 302. 비로그인 화면 반영은 최대 60초. T-12c: 같은 화면에 "보관 기간" 구역(지금 값·범위·안내·마지막 변경 누가/언제·최근 변경 5줄), `?ok=retention_saved\|retention_unchanged` | ✅ |
| POST /admin/settings/retention | 보관 기간 1단계: `application_keep_days`·`application_auto_close_days`·`vdoc_keep_days`·`access_log_keep_days`·`job_stale_days`(+ `job_stale_off=1` 이면 0 = 끔) → `validateRetentionForm`(칸별 오류는 400 + 입력 유지) → 바뀐 것이 없으면 303 `?ok=retention_unchanged` → 확인 화면(바뀌는 칸 지금 → 바꾼 뒤, 결과: 더 일찍 삭제·되돌릴 수 없음 / 새 지원서에만 / 모든 회원 다시 동의 / 자동 마감 끔, 숨은 칸에 새 값과 `base`(지금 값), "확인했습니다" 체크 칸). 저장하지 않음 | ✅ T-12c |
| POST /admin/settings/retention/confirm | 보관 기간 2단계: 다시 검사(400) → 지금 값이 `base` 와 다르면 400 + 지금 값 기준 확인 화면 → `confirm=1` 없으면 400 + 확인 화면 → `planRetentionSave`(개인정보 기간이 늘면 rev +1) → `retention` 과 `retention.log`(최근 20줄, 시각·관리자 id·old → new) 를 한 트랜잭션으로 저장(`updated_by`) → 303 `/admin/settings?ok=retention_saved#retention` | ✅ T-12c |
| GET /admin/options | 직무·업계·근무지 항목 관리: 종류별 표(코드·한국어·중국어 이름·순서·상태·쓰는 공고 수), 줄마다 이름·순서 수정과 사용 종료/다시 사용, 종류마다 추가 폼. 삭제 없음 | ✅ |
| POST /admin/options/:kind/add | 항목 추가 (`code`·`label_ko`·`label_zh`·`sort`). code 형식 `[a-z][a-z0-9_]{1,29}`, 같은 종류 안에서 중복 금지(사용 종료 포함). 오류는 400 + 안내 | ✅ |
| POST /admin/options/:kind/:code/edit | 이름·순서 수정 (code·종류는 바꿀 수 없음). 없는 항목은 404 | ✅ |
| POST /admin/options/:kind/:code/retire · /restore | 사용 종료 · 다시 사용. 종류의 마지막 사용 중 항목은 사용 종료 거부(400). 비로그인 화면 반영은 최대 60초 | ✅ |
| GET /admin/applications/:id | 지원서 정보(공고 제목·기업 id·지원일·상태·동의/첨부 여부 — 개인정보 없음) + "열람 사유" 폼(필수, 300자). 기록하지 않음. 취소된 지원은 안내만 | ✅ T-09a |
| POST /admin/applications/:id/open | 사유(`reason`) → `openApplication` → 내용은 이 POST 응답에만 그린다(리다이렉트 없음). access_log 에 사유, 상태 변경 없음. 사유 없음·300자 초과는 400 + 오류, 취소됨·열 수 없음은 안내 | ✅ T-09a |
| POST /admin/applications/:id/file | 사유와 함께 첨부 내려받기 (`downloadApplicationFile`, access_log 에 사유). 안 되면 400 + 지원서 화면 | ✅ T-09a |
| GET /admin/system | 시스템 점검 (T-13, `private, no-store`, 로그인 리다이렉트·403 포함): 실행 환경, 설정 점검 표(`lib/config-check.configChecks` — ok·확인·문제 + 고치는 법), 비밀값 표(설정됨/없음 + 길이 구간, **값은 없음**), 오늘 사용량, 보관 기간(읽기만), 예약 작업 시간표(UTC·한국 시간, 붙은 단계 `sendAlerts` 표시), 마이그레이션 확인 방법 안내, T-10 "조건 알림"(켜진·꺼진 알림 수, 오늘 알림 메일 `쓴 수 / 한도` — 개수만, 누구의 어떤 조건인지 없음). 읽기: 사용량 2 + 보관 기간 설정 1 + 알림 개수 1 + 알림 메일 1. 요청을 막지 않는다. 관리자 첫 화면에서 링크 | ✅ T-13 |
| GET·POST /admin/users/2fa-reset · POST /admin/users/2fa-reset/confirm | 회원 2단계 인증 초기화 (T-16, `private, no-store`, 로그인 리다이렉트·403 포함): 폼(`email`, `reason` 10자 이상) → POST 검사(사유 짧음·회원 없음·관리자 계정·2단계 인증 꺼짐 → 400 + 안내) → 확인 화면(이메일·유형·사유, 숨은 칸) → `/confirm` 에서 다시 검사 → 한 트랜잭션: `admin_actions` 기록 + 비밀키·복구 코드·대기·모든 세션 삭제 → 회원에게 알림 메일 → 303 `?ok=1`. 관리자 계정은 대상이 아니다(README DB 명령). 관리자 첫 화면에서 링크 | admin (TOTP 세션) | ✅ T-16 |
| GET /admin/access-log | 열람 기록: 최근 순 50건씩, `?type=application\|resume\|verification_doc`(그 밖의 값은 무시), `?before=<시각>` 커서. 시각·연 사람(이메일·역할)·대상·사유. 지원서 대상은 관리자 지원서 화면으로 연결 | ✅ T-09a |

관리자에게 **없는** 기능: 조건 알림을 보거나 만들거나 보내기(T-10 — 개수만 보인다), 개인정보 "영구 보관"·"지우지 않기" 설정(T-12c — 범위 안의 기간만), 공고 내용 수정, 이력서 전달, 구직자·기업에게 추천 발송, 지원자에게 메일 보내기(면접 요청·불합격 통보는 기업 담당자만, T-09b), 지원자 목록·사람 검색, 지원서 수정·일괄 내려받기.
