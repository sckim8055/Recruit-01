# 경로 목록

화면은 서버 렌더링 + HTML 폼이다. `✅` 는 구현됨, 나머지는 docs/TASKS.md 의 해당 작업에서 만든다.
모든 POST 는 같은 출처에서 온 요청만 받는다(`sameOrigin`). "권한" 칸의 판단은 `authz.ts`·`requireRole` 을 쓴다.

## 공통
| 경로 | 설명 | 권한 | 상태 |
|---|---|---|---|
| GET / | 홈 | 누구나 | ✅ |
| GET /login · POST /login/request · POST /login/verify | 이메일 인증코드 로그인·가입 | 누구나 | ✅ |
| POST /logout | 로그아웃 | 로그인 | ✅ |
| GET /lang/:l | 언어 전환 (ko/zh) | 누구나 | ✅ |
| GET /my | 역할별 첫 화면 (구직자: 지원 현황 자리, 기업·헤드헌터 → /biz, 관리자 → /admin) | 로그인 | ✅ |
| GET /biz | 기업·헤드헌터 첫 화면 | company, headhunter | ✅ (임시 화면) |
| GET /api/health | 상태 확인 | 누구나 | ✅ |
| (없는 경로) · 권한 없음 | 404 · 403 화면 (공통 레이아웃, 한국어·중국어) | 누구나 | ✅ |
| GET /terms · /privacy | 약관·개인정보처리방침 | 누구나 | T-11 |

## 구직자
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| GET /jobs | 공고 목록·필터 (published, office 만) | 누구나 | T-06 |
| GET /jobs/:id | 공고 상세 (기업 연락처 표시) | 누구나 | T-06 |
| GET /companies · /companies/:id | 기업 목록·기업 페이지 | 누구나 | T-04 |
| GET /my/resumes · GET·POST /my/resumes/new · /my/resumes/:id | 이력서 목록·작성·수정 (여러 개) | seeker 본인 | T-07 |
| POST /my/resumes/:id/default · /copy · /delete | 대표 지정·복사·삭제 | seeker 본인 | T-07 |
| GET·POST /jobs/:id/apply | 지원 (국외 이전 동의 포함) | seeker | T-08 |
| GET /my/applications | 지원 현황 (자동 상태) | seeker | T-08 |
| POST /my/applications/:id/withdraw | 지원 취소 | seeker 본인 | T-08 |
| GET·POST /my/alerts | 조건 알림 설정 | seeker | T-10 |

## 기업
| 경로 | 설명 | 권한 | 작업 |
|---|---|---|---|
| GET·POST /biz/company | 기업 등록·기업 페이지 편집 | company | T-04 |
| POST /biz/company/docs | 검증 서류 업로드 (R2) | company | T-04 |
| GET·POST /biz/members | 담당자 초대 | company owner | T-04 |
| GET /biz/jobs · GET·POST /biz/jobs/new · /biz/jobs/:id | 공고 작성(중국어)·수정 | canEditJob | T-05 |
| POST /biz/jobs/:id/localize | AI 현지화 초안 + 대조본 생성 | canEditJob | T-05 |
| POST /biz/jobs/:id/publish | 게재 (`publishBlocks` 가 비어야 함) | canEditJob | T-05 |
| POST /biz/jobs/:id/close | 마감 | canEditJob | T-05 |
| GET /biz/jobs/:id/applicants | 지원자 목록 | canEditJob | T-09 |
| GET /biz/applications/:id | 지원서 열람 → `viewed` 이벤트 + access_log | canViewApplication | T-09 |
| POST /biz/applications/:id/interview | 면접 요청 메일 (답장 주소 = 기업 담당자) → `interview_mail` | canViewApplication | T-09 |
| POST /biz/jobs/:id/reject | 불합격 일괄 통보 → `reject_mail` | canEditJob | T-09 |

## 관리자
| 경로 | 설명 | 작업 |
|---|---|---|
| GET /admin | 검증 대기·검토 대기·신고·사용량 | T-03 (T-02 에서 임시 화면 ✅) |
| POST /admin/companies/:id/verify | 기업 승인·반려 | T-04 |
| POST /admin/jobs/:id/block · /clear-review | 공고 차단 · 기술유출 검토 통과 | T-05 |
| GET /admin/applications/:id?reason= | 사유 입력 후 지원서 열람 (access_log) | T-09 |
| GET /admin/access-log | 열람 기록 | T-09 |

관리자에게 **없는** 기능: 공고 내용 수정, 이력서 전달, 구직자·기업에게 추천 발송.
