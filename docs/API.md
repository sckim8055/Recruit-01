# 경로 목록

화면은 서버 렌더링 + HTML 폼이다. `✅` 는 구현됨, 나머지는 docs/TASKS.md 의 해당 작업에서 만든다.
모든 POST 는 같은 출처에서 온 요청만 받는다(`sameOrigin`). `/my/resumes*` 는 구직자만(기업·헤드헌터·관리자 403, 남의 이력서 id 는 404), 모든 응답이 `Cache-Control: private, no-store`. "권한" 칸의 판단은 `authz.ts`·`requireRole` 을 쓴다.

## 공통
| 경로 | 설명 | 권한 | 상태 |
|---|---|---|---|
| GET / | 홈 (소개 + 최신 공개 공고 5건). 비로그인은 60초 캐시 | 누구나 | ✅ |
| GET /login · POST /login/request · POST /login/verify | 이메일 인증코드 로그인·가입 | 누구나 | ✅ |
| POST /logout | 로그아웃 | 로그인 | ✅ |
| GET·POST /login/totp | 관리자 2단계 인증 (최초에는 인증 앱 등록) | 인증코드를 통과한 관리자 | ✅ |
| GET /lang/:l | 언어 전환 (ko/zh) | 누구나 | ✅ |
| GET /my | 역할별 첫 화면 (구직자: 이력서 링크 + 지원 현황 자리, 기업·헤드헌터 → /biz, 관리자 → /admin) | 로그인 | ✅ |
| GET /biz | 기업 첫 화면 (소속 없음: 받은 초대 + 기업 등록 폼 / 소속 있음: 검증 상태·남은 할 일). 헤드헌터는 임시 화면 | company, headhunter | ✅ |
| GET /api/health | 상태 확인 | 누구나 | ✅ |
| (없는 경로) · 권한 없음 | 404 · 403 화면 (공통 레이아웃, 한국어·중국어) | 누구나 | ✅ |
| GET /terms · /privacy | 약관·개인정보처리방침 | 누구나 | T-11 |

## 구직자
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| GET /jobs | 공고 목록 (공개 조건: ARCHITECTURE 9장). 필터 `chinese_level` `role_category` `industry` `entry_stage` `salary_basis` `report_line` `location` 중 관리자가 보이게 한 것만(기본: `chinese_level` `report_line` `location`, `/admin/settings`), `page`(20건씩, 최대 100). 직무·업계·근무지 값은 사용 중인 항목(`job_options`, `/admin/options`)만 받는다. 빈 칸·모르는 조건·숨긴 조건·사용 종료된 항목 값이 붙은 주소는 정규화 주소로 302. 비로그인은 60초 캐시 | 누구나 | ✅ |
| GET /jobs/:id | 공고 상세 (구조 항목·기업·기업 연락처. 지원 버튼은 T-08). 보이지 않는 공고는 404. 비로그인은 60초 캐시 | 누구나 | ✅ |
| GET /companies · /companies/:id | 기업 목록·기업 페이지 (검증된 기업만, "기업 제공 정보" 표시. 사업자번호·담당자·서류는 공개하지 않음) | 누구나 | ✅ |
| GET /my/resumes | 내 이력서 목록 (대표 먼저, 최대 5개). 줄마다 제목·한 줄 소개·수정일·첨부파일 이름·지원 가능 여부, 수정·복사·대표로 지정·삭제. 열 수 없는 이력서(복호화 실패)는 "열 수 없는 이력서" + 삭제만. 결과 표시는 `?ok=created\|saved\|copied\|copied_nofile\|default\|deleted`, `?err=limit` 뿐 | seeker 본인 | ✅ |
| GET·POST /my/resumes/new | 새 이력서 (multipart: 항목 + 첨부파일 `attachment` 1개, PDF·DOCX 5MB). 연락 이메일 기본값 = 계정 이메일. 첫 이력서는 대표. 5개면 `?err=limit` 로 302. 본문이 6MB 를 넘으면(`content-length`) 읽지 않고 413. 항목·파일 오류는 400 + 입력값 유지(파일은 다시 골라야 함) | seeker 본인 | ✅ |
| GET·POST /my/resumes/:id/edit | 수정 (`updated_at` 숨은 칸 = 화면을 연 때의 버전. 다르면 400 + 안내 + 입력값 유지). 첨부파일: 새 파일이면 교체, `remove_file=1` 이면 삭제, 아니면 유지. 예전 R2 객체는 DB 갱신이 성공한 뒤에 지운다 | seeker 본인 (`canEditResume`) | ✅ |
| GET /my/resumes/:id/file | 첨부파일 내려받기 (항상 attachment, 미리보기 없음, access_log). `serveResumeFile` 만 쓴다 | seeker 본인 (`canViewResume`) | ✅ |
| POST /my/resumes/:id/copy | 복사 ("제목 (복사)", 중국어 화면은 "(副本)"). 첨부파일은 새 R2 객체로 다시 암호화해 복사. 원본 파일이 없으면 첨부 없이 복사(`ok=copied_nofile`). 5개면 `?err=limit` | seeker 본인 | ✅ |
| POST /my/resumes/:id/default | 대표 이력서 지정 | seeker 본인 | ✅ |
| GET·POST /my/resumes/:id/delete | 삭제 확인 화면(제목, 낸 지원서는 영향 없음 안내) → 삭제. 대표를 지우면 가장 최근에 고친 것이 대표. 행을 지운 뒤 R2 객체를 지운다 | seeker 본인 | ✅ |
| GET·POST /jobs/:id/apply | 지원 (국외 이전 동의 포함) | seeker | T-08 |
| GET /my/applications | 지원 현황 (자동 상태) | seeker | T-08 |
| POST /my/applications/:id/withdraw | 지원 취소 | seeker 본인 | T-08 |
| GET·POST /my/alerts | 조건 알림 설정 | seeker | T-10 |

## 기업
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| POST /biz/company | 기업 등록 (대표 담당자 자동 지정. 이미 소속이 있으면 거부). GET 은 /biz 로 보냄 | company (소속 없음) | ✅ |
| GET·POST /biz/company/edit | 기업 정보 편집 (검증 뒤 기업명·사업자 형태·번호 잠금) | canManageCompany | ✅ |
| GET·POST /biz/company/docs | 검증 서류 목록·업로드 (R2 비공개, 기업당 5개) | canManageCompany | ✅ |
| GET /biz/docs/:id | 검증 서류 내려받기 (access_log) | canViewVerificationDoc | ✅ |
| GET /biz/members | 담당자·대기 초대 목록 (대표 담당자가 아니면 읽기만) | canManageCompany | ✅ |
| POST /biz/members/invite · /biz/members/:userId/remove · /biz/invites/:id/cancel | 담당자 초대(초대 메일 `company_invite` 발송, 실패해도 초대 유지)·내보내기·초대 취소 | canManageMembers (owner) | ✅ |
| POST /biz/invites/:id/accept | 초대 수락 (초대받은 이메일 본인, 소속 없을 때만) | company | ✅ |
| GET /biz/jobs · GET·POST /biz/jobs/new | 공고 목록 · 새 공고(중국어 원문 + 조건). 남의 공고는 404 | 소속 기업 담당자 | ✅ |
| GET /biz/jobs/:id | 확인 화면: 원문 \| 한국어 초안 \| 대조본, 숫자 대조 경고, 게재 조건 목록 | canEditJob | ✅ |
| GET·POST /biz/jobs/:id/edit | 원문·조건 편집 (마감된 공고는 불가). 글을 고치면 승인이 풀리고 게재 중이면 게재 중단 | canEditJob | ✅ |
| POST /biz/jobs/:id/localize | 현지화 초안 + 대조본 생성 (`again=1` 이면 지난번 다음 엔진부터). 엔진이 없으면 수동 입력 안내 | canEditJob | ✅ |
| POST /biz/jobs/:id/korean | 한국어 초안 직접 입력·수정 (대조본 지움, 다시 승인 필요) | canEditJob | ✅ |
| POST /biz/jobs/:id/approve | 한국어 초안 승인 (본 rev 일 때만) | canEditJob | ✅ |
| POST /biz/jobs/:id/publish | 게재 (`publishBlocks` 가 비어야 함) | canEditJob | ✅ |
| POST /biz/jobs/:id/close | 마감 (게재 중 → 마감, 다시 열기 없음) | canEditJob | ✅ |
| GET /biz/jobs/:id/applicants | 지원자 목록 | canEditJob | T-09 |
| GET /biz/applications/:id | 지원서 열람 → `viewed` 이벤트 + access_log | canViewApplication | T-09 |
| POST /biz/applications/:id/interview | 면접 요청 메일 (답장 주소 = 기업 담당자) → `interview_mail` | canViewApplication | T-09 |
| POST /biz/jobs/:id/reject | 불합격 일괄 통보 → `reject_mail` | canEditJob | T-09 |

## 관리자
| 경로 | 설명 | 작업 |
|---|---|---|
| GET /admin | 처리할 일 개수 (검증 대기·검토 대기·신고). 검증 대기 기업 → /admin/companies, 검토 대기 공고 → /admin/jobs, 신고 목록은 T-09 | ✅ |
| GET /admin/companies · /admin/companies/:id | 기업 목록(검증 대기 먼저)·상세 (담당자 이메일, 서류, `verifyBlocks` 결과) | ✅ |
| POST /admin/companies/:id/verify | 기업 승인(`verifyBlocks` 가 비어야 함)·반려(사유 필수, `reject_docs` 체크 시 서류도 반려). 검증 대기 상태에서만 | ✅ |
| POST /admin/companies/:id/revoke | 승인 취소(사유 필수, `reject_docs` 체크 시 서류도 반려). 검증 완료 상태에서만. 기업은 반려 상태, 게재 중 공고는 `closed` | ✅ |
| GET /admin/docs/:id | 검증 서류 내려받기 (access_log) | ✅ |
| GET /admin/jobs · /admin/jobs/:id | 검토 대기(기술유출 필터)·차단 공고 목록·상세 (한국어·원문·대조본·사유) | ✅ |
| POST /admin/jobs/:id/clear-review · /block · /unblock | 검토 통과(본 rev 일 때만) · 차단(사유 필수) · 차단 해제(→ 미게재). 내용 수정·게재는 없다 | ✅ |
| GET·POST /admin/localize-test | 현지화 엔진 비교 (같은 글을 엔진별로, 초안·대조본·시간·오류). 저장하지 않음 | ✅ |
| GET·POST /admin/settings | 사이트 설정: `/jobs` 검색 칸에 보일 필터 체크박스(`filters`, 여러 개). `FILTER_KEYS` 밖의 값은 버림, 모두 끄면 빈 목록 저장(`site_settings.public_job_filters`). 저장 후 `?ok=saved` 로 302. 비로그인 화면 반영은 최대 60초 | ✅ |
| GET /admin/options | 직무·업계·근무지 항목 관리: 종류별 표(코드·한국어·중국어 이름·순서·상태·쓰는 공고 수), 줄마다 이름·순서 수정과 사용 종료/다시 사용, 종류마다 추가 폼. 삭제 없음 | ✅ |
| POST /admin/options/:kind/add | 항목 추가 (`code`·`label_ko`·`label_zh`·`sort`). code 형식 `[a-z][a-z0-9_]{1,29}`, 같은 종류 안에서 중복 금지(사용 종료 포함). 오류는 400 + 안내 | ✅ |
| POST /admin/options/:kind/:code/edit | 이름·순서 수정 (code·종류는 바꿀 수 없음). 없는 항목은 404 | ✅ |
| POST /admin/options/:kind/:code/retire · /restore | 사용 종료 · 다시 사용. 종류의 마지막 사용 중 항목은 사용 종료 거부(400). 비로그인 화면 반영은 최대 60초 | ✅ |
| GET /admin/applications/:id?reason= | 사유 입력 후 지원서 열람 (access_log) | T-09 |
| GET /admin/access-log | 열람 기록 | T-09 |

관리자에게 **없는** 기능: 공고 내용 수정, 이력서 전달, 구직자·기업에게 추천 발송.
