# DB 이전 안내 (SQLite/D1 → PostgreSQL)

지금은 Cloudflare D1(SQLite)을 쓴다. 나중에 PostgreSQL 로 옮길 때 무엇을 고쳐야 하는지 적은 문서다.
"확인 필요" 표시는 이 문서를 쓸 때 직접 시험해 보지 않은 내용이다. 옮기기 전에 반드시 시험한다.

## 1. DB 코드가 있는 곳

- **모든 SQL 과 D1 호출은 `src/db/` 에만 있다** (T-05d). 라우트(`src/routes/`)와 lib 는 `env.DB` 를 이 폴더의 함수에 넘기기만 한다.
  `test/db-layer.test.ts` 가 이 경계를 검사한다 (밖에서 `.prepare(`·`.batch(`·`meta.changes`·SQL 문자열을 쓰면 테스트 실패).

| 파일 | 다루는 표 |
|---|---|
| `src/db/users.ts` | users (로그인 시 조회·생성, TOTP 확정) |
| `src/db/sessions.ts` | auth_codes, sessions, admin_totp_pending |
| `src/db/companies.ts` | companies, company_members, company_invites, verification_docs(행), agency_members |
| `src/db/jobs.ts` | jobs |
| `src/db/public-jobs.ts` | jobs + companies (공개 공고 목록·상세, 읽기만) |
| `src/db/logs.ts` | access_log, email_log |
| `src/db/admin.ts` | 관리자 첫 화면 개수 (companies·agencies·jobs·reports) |
| `src/db/settings.ts` | site_settings (사이트 설정 이름 → 값, upsert) |
| `src/db/resumes.ts` | resumes (내 이력서 목록·한 개·개수, 5개 한도 안에서 추가, 버전 비교 수정, 대표 지정, 삭제 + 대표 승계, 파일 키 목록). 모든 문장에 `user_id` 조건 |
| `src/db/options.ts` | job_options (직무·업계·근무지 선택 항목: 전체 읽기·추가·이름/순서 수정·사용 종료/다시 사용) + 항목별 공고 수 |
| `src/db/applications.ts` | applications · application_events · consents(cross_border): 지원 여부, 기업 담당자 수(본사/그 밖)·알림 주소(활성 계정), 공개 조건·중복을 다시 확인하는 조건부 추가(+ 동의), 내 지원 한 건·목록, 취소(이벤트 + 상태 + 내용 삭제 + 동의 철회), 파일 키 목록. 구직자 쪽 문장은 모두 `seeker_id` 조건 |
| `src/db/application-views.ts` | applications + jobs + companies (지원 현황 화면: 내가 지원한 공고 중 지금 공개 중인 공고 id, `publicJobWhere` 재사용, 읽기만) |
| `src/db/applicants.ts` | applications + jobs + access_log + users (기업·관리자 쪽, T-09): 공고의 지원 목록(내용 없음), 기업의 공고별 지원 수, 지원 한 건 + 공고 소속(권한 판단용, 암호문 포함 — `lib/applicants.openApplication` 만 쓴다), `viewed` 이벤트 + 상태, 열람 기록 목록(관리자)·지원서별 열람 기록(구직자, 역할·시각만) |
| `src/db/consents.ts` | consents (type `terms`·`privacy`): 그 회원의 필수 동의 읽기(요청마다 한 번, `idx_consents_user`), 같은 판의 유효한 동의가 없을 때만 추가. 국외 이전(`cross_border`)은 `applications.ts` |
| `src/db/account.ts` | 회원 탈퇴(T-11): 다른 담당자가 있는 기업의 대표인지 세기, 한 트랜잭션으로 지우기 — applications·application_events·consents·resumes·seeker_profiles·alerts·jobs(혼자 맡던 기업의 게재 중 공고 마감)·company_members·agency_members·company_invites·sessions·admin_totp_pending·auth_codes·users(이메일 익명화, `status = 'deleted'`) |
| `src/db/applicant-views.ts` | application_events + applications (기업 지원자 목록 화면, T-09b): 공고 하나의 지원별 면접 요청 메일 수 — `GROUP BY` 한 번, 읽기만. `COUNT(*)` 는 `Number()` 로 바꿔 쓴다 (PostgreSQL bigint 대비) |

- 스키마는 `migrations/` (SQLite 문법). 판단 규칙(`rules.ts`·`authz.ts`)·TTL·횟수 제한은 DB 와 무관하므로 옮길 때 고치지 않는다.

## 2. PostgreSQL 로 옮길 때 하는 일

1. **`src/db/*` 를 PostgreSQL 드라이버로 다시 쓴다.** 함수 이름·인자·돌려주는 값은 그대로 두면 라우트는 고치지 않아도 된다.
   - 자리표시자 `?` → `$1, $2, …` (문장마다 순서 그대로). 한곳에서 바꿔 주는 작은 도우미를 두는 방법도 있다.
   - `db.batch([...])` → `BEGIN … COMMIT` 트랜잭션. **문장 순서를 바꾸지 않는다** (가드가 앞 문장의 결과에 기대는 곳이 있다).
   - `meta.changes` → 드라이버의 `rowCount`. "N 번째 문장의 영향 행 수가 1 인가" 판단은 그대로 둔다.
   - `.first()` → 첫 행 또는 `null`, `.all().results` → 행 배열.
2. **스키마를 PostgreSQL 문법으로 새로 쓴다** (마이그레이션 파일을 하나씩 옮기기보다 최종 모양으로 한 번에).
   - id: `TEXT` UUID 그대로 둘 수 있다 (`uuid` 형으로 바꿔도 되지만 필수는 아니다).
   - 시각: INTEGER 에포크 초. **PostgreSQL `integer` 는 32비트라 2038년에 넘친다 → `bigint` 로.**
     단 `bigint` 는 node-postgres 등에서 문자열로 올 수 있어 숫자로 바꾸는 설정이 필요하다 (확인 필요).
   - 0/1 값(`is_hq`, `sessions.mfa`, `resumes.is_default`, `jobs.company_name_public`): `integer` 로 두면 코드 변경이 없다.
     `boolean` 으로 바꾸면 아래 `[sqlite]` 목록의 해당 함수와 이 값을 읽는 코드(lib/actor.ts, lib/auth.ts sessionUsable, lib/company.ts)를 같이 고친다.
   - `CHECK (... IN (...))` 제약은 PostgreSQL 에서도 그대로 쓸 수 있다.
   - 부분 유일 인덱스 `idx_resumes_default ... WHERE is_default = 1` 도 PostgreSQL 이 지원한다 (boolean 으로 바꾸면 `WHERE is_default`).
   - 유일 인덱스 `idx_company_invites_email (company_id, email)` 은 초대 중복을 막는 데 쓰인다. 반드시 옮긴다.
3. **데이터 복사:** 서비스를 잠시 멈추고 D1 에서 내보내기(`wrangler d1 export`) → 표마다 PostgreSQL 로 넣기 → 행 수 비교.
   이력서 등 🔒 컬럼은 암호문 그대로 옮긴다 (`ENC_KEY` 는 바꾸지 않는다). 순서는 users → companies → … 처럼 참조되는 표부터.
4. **Worker 에서 PostgreSQL 에 붙는 방법:** Cloudflare **Hyperdrive** (연결 풀·지역 캐시를 제공하는 Cloudflare 서비스)를 만들고
   `wrangler.jsonc` 에 바인딩을 추가한 뒤, Worker 에서 PostgreSQL 드라이버(`pg` 또는 `postgres`)로 연결한다. `nodejs_compat` 설정이 필요할 수 있다.
   요금·무료 플랜 포함 여부·지원 드라이버 버전은 **확인 필요**. 중국에서의 접속 속도도 시험해 봐야 한다.
5. 테스트: `npm test` 는 DB 없이 돈다. 옮긴 뒤에는 `wrangler dev` 로 로그인·기업 등록·검증·공고 게재 흐름을 다시 확인한다 (T-05d 때 한 목록과 같게).

## 3. SQLite 전용 부분 목록 (`src/db/` 안 `// [sqlite]` 주석)

| 위치 | 내용 | PostgreSQL 에서 |
|---|---|---|
| 모든 쓰기 함수 (`companies.ts`, `jobs.ts` 파일 머리말) | `meta.changes` | `rowCount` |
| `users.confirmTotp`, `companies.registerCompany` · `saveCompanyEdit` · `acceptInvite` · `removeMember` · `rejectCompany` · `approveCompany` · `revokeCompany` | `batch` = 암묵적 트랜잭션 | `BEGIN … COMMIT`, 순서 그대로 |
| `companies.listMembersAndInvites` · `inviteConflicts` · `loadCompanyDetail`, `admin.adminCounts` | 읽기 전용 batch | 조회 여러 번 또는 한 트랜잭션 |
| `sessions.insertSession` · `findSessionUser` | `mfa` INTEGER 0/1 | integer 로 두거나, boolean 이면 `sessionUsable` 도 수정 |
| `companies.listCompanyMembershipsOfUser` · `registerCompany` · `saveCompanyEdit` 등 (`is_hq` 를 읽고 쓰는 곳) | `is_hq` INTEGER 0/1 | 위와 같음 |
| `companies.registerCompany` · `acceptInvite` · `insertInviteWithinLimit` | `INSERT … SELECT ?,… WHERE …` 조건부 추가 | 문법은 된다. FROM 없는 SELECT 목록의 매개변수는 text 로 정해질 수 있어 숫자 컬럼에 `$n::integer` 가 필요할 수 있다 (확인 필요) |
| `companies.insertInviteWithinLimit` | 유일 인덱스 위반 시 예외 | PostgreSQL 은 SQLSTATE 23505. 지금 호출부는 예외 종류를 보지 않고 "중복" 으로 안내하므로 그대로 된다 |
| `companies.listCompaniesForAdmin`, `admin.adminCounts` | `COUNT(*)` 가 숫자로 옴 | bigint → 문자열로 올 수 있음. `COUNT(*)::int` 또는 변환 (확인 필요) |
| `public-jobs.ts` (`LIST_COLS`) | `CASE WHEN j.company_name_public = 1` — INTEGER 0/1 | integer 로 두면 그대로. boolean 이면 `WHEN j.company_name_public` |
| `options.ts` (파일 머리말) | `meta.changes`, `active` INTEGER 0/1 (`active = 1`) | `rowCount`. boolean 으로 바꾸면 SQL 과 `lib/options.buildOptionSet` 수정 |
| `options.countOptionUsage` | `COUNT(*)` 가 숫자로 옴 | `COUNT(*)::int` 또는 변환 (확인 필요) |
| `options.setOptionActive` | 사용 종료 가드 `… AND (SELECT COUNT(*) FROM job_options WHERE kind = ? AND active = 1) > 1` — D1 은 쓰기가 순서대로라 안전 | 문법은 된다. 동시성은 4장 |
| `resumes.ts` (파일 머리말) | `is_default` INTEGER 0/1 (`= 1`/`= 0`), 회원당 대표 하나는 부분 유일 인덱스 `idx_resumes_default … WHERE is_default = 1` 이 지킨다, `meta.changes` | integer 로 두면 그대로. boolean 이면 `WHERE is_default` 와 비교 수정 |
| `resumes.insertResume` | `INSERT … SELECT ?,…, CASE WHEN EXISTS … THEN 0 ELSE 1 END … WHERE (SELECT COUNT(*) …) < ?` — 한도·첫 이력서 대표를 한 문장으로 | 문법은 된다. FROM 없는 SELECT 의 매개변수 형 지정이 필요할 수 있다(확인 필요). 동시에 두 번 추가하면 둘 다 통과해 6개가 될 수 있다(4장) |
| `resumes.setDefaultResume` · `deleteResume` | `batch` = 트랜잭션. 대표 지정은 "기존 대표 내리기 → 대상 올리기" 순서(바꾸면 유일 인덱스 위반), 삭제는 "지우기 → 대표가 없으면 가장 최근 것을 대표로" | `BEGIN … COMMIT`, 순서 그대로 |
| `resumes.countResumes` | `COUNT(*)` 가 숫자로 옴 | `COUNT(*)::int` 또는 변환 (확인 필요) |
| `applications.insertApplication` | `INSERT … SELECT … FROM jobs JOIN companies WHERE 공개 조건 AND NOT EXISTS (…)` + 같은 batch 의 `INSERT INTO consents … SELECT … WHERE EXISTS (방금 넣은 지원)`. `UNIQUE (job_id, seeker_id)` 위반 예외는 false 로 바꾼다 | `BEGIN … COMMIT`, 순서 그대로. 유일 제약 위반은 SQLSTATE 23505 (호출부는 예외 종류를 보지 않는다). 동시 두 INSERT 는 4장 — 이 표는 유일 제약이 막는다 |
| `applications.withdrawApplication` | batch 세 문장(이벤트 추가 → 상태·내용 지우기 → 동의 철회). 앞 두 문장이 같은 `status IN (…)` 가드를 쓰고, 세 번째는 바뀐 상태를 확인한다. 판단은 두 번째 문장의 영향 행 수 | `BEGIN … COMMIT`, 순서 그대로 (순서를 바꾸면 이벤트 가드가 바뀐 상태를 본다) |
| `applications.memberCounts` | `SUM(CASE …)` 가 숫자로 옴, `is_hq` INTEGER 0/1 | `SUM` 은 bigint/numeric → 숫자 변환(확인 필요). boolean 이면 `CASE WHEN is_hq` |
| `applications.listOwnApplications`, `application-views.listVisibleAppliedJobIds` | `CASE WHEN j.company_name_public = 1`, `LIMIT 200` | integer 로 두면 그대로 |
| `applicants.listJobApplications` | `CASE WHEN file_r2_key IS NOT NULL THEN 1 ELSE 0 END AS has_file` (0/1), `LIMIT 500` | 그대로 되지만 PostgreSQL 에서 `file_r2_key IS NOT NULL` 만 쓰면 boolean 이 오므로 호출부 비교(`has_file === 1`)를 같이 고친다 |
| `applicants.countApplicationsByJob` | `SUM(CASE …)` 가 숫자로 옴 | bigint/numeric → 숫자 변환(확인 필요). 호출부가 `Number()` 로 감싼다 |
| `applicants.markViewed` | batch 두 문장(이벤트 `INSERT … SELECT … WHERE status = 이전 상태` → `UPDATE … WHERE status = 이전 상태`). 판단은 두 번째 문장의 영향 행 수 | `BEGIN … COMMIT`, 순서 그대로 (바꾸면 이벤트 가드가 바뀐 상태를 본다). 두 사람이 동시에 처음 열면 PostgreSQL READ COMMITTED 에서 둘 다 INSERT 가 통과할 수 있다(4장) — `viewed` 가 두 줄 남지 않게 잠금 또는 UPDATE 를 먼저 하고 RETURNING 으로 확인 |
| `applicants.listAccessLog` | `(? IS NULL OR l.at < ?)` — 같은 값을 두 번 바인딩하는 선택 조건 | PostgreSQL 은 `$1 IS NULL` 의 형을 정하지 못할 수 있다 → `$1::bigint IS NULL OR l.at < $1` / `$2::text` (확인 필요) |
| `consents.insertConsents` | batch(종류마다 `INSERT … SELECT ?,… WHERE NOT EXISTS (같은 판의 유효한 동의)`) | `BEGIN … COMMIT`. FROM 없는 SELECT 의 매개변수 형 지정이 필요할 수 있다(확인 필요). 동시 두 요청은 4장 — 같은 판 동의가 두 줄 생길 수 있지만 판단(`missingConsents`)에는 영향 없음 |
| `account.eraseUser` | batch 14문장 = 한 트랜잭션. 이벤트 id 를 **`lower(hex(randomblob(16)))`** 로 SQL 안에서 만든다(다른 곳의 UUID 와 모양이 다르다: 하이픈 없는 32자). 세션·2단계 대기 삭제를 뺀 모든 문장이 "아직 탈퇴 전"(`EXISTS … status != 'deleted'`)을 조건으로 하고 `users` 갱신이 맨 마지막 — 순서를 바꾸면 앞 문장들이 실행되지 않는다. 판단은 마지막 문장의 영향 행 수 | `gen_random_uuid()::text`(또는 앱에서 id 를 만들어 바인딩), `BEGIN … COMMIT`, 순서 그대로 |
| `account.countOwnedCompaniesWithOthers` | `COUNT(*)` 가 숫자로 옴 | `COUNT(*)::int` 또는 변환(호출부가 `Number()` 로 감싼다) |
| `migrations/0007_job_options.sql` | 기본 행의 시각 `strftime('%s','now')` | `extract(epoch from now())::bigint` |
| `companies.listPublicCompanies` | `ORDER BY name_ko` = 바이트 순서 | DB 콜레이션에 따라 한글 정렬이 달라질 수 있음 (`COLLATE "C"` 로 맞춤) |

PostgreSQL 에서도 그대로 되는 것(표시하지 않음): `ON CONFLICT … DO UPDATE … excluded`(`settings.setSetting` 포함), `ON CONFLICT (kind, code) DO NOTHING`(`options.insertOption`),
`SELECT … UNION ALL SELECT …`(`options.countOptionUsage`), `EXISTS (…)` 가드, `UPDATE … WHERE … AND EXISTS`,
`ORDER BY 식 = '값' DESC`(참/거짓 정렬), `CASE`, `LIMIT`, `rev = rev + 1`.
`public-jobs.ts` 의 `LIMIT ? OFFSET ?`, `CASE WHEN … END`(ELSE 없으면 NULL)도 그대로 된다. 목록 정렬 `published_at DESC, id DESC` 의 id 는 TEXT 이므로
PostgreSQL 콜레이션에 따라 같은 시각 안의 순서만 달라질 수 있다(페이지가 겹치지 않으려면 `COLLATE "C"` 권장, 확인 필요).
지금 코드는 `datetime()`·`strftime`·`rowid`·`INSERT OR IGNORE/REPLACE`·`LIKE` 를 쓰지 않는다.

## 4. 이 계층으로 쉬워지지 않는 것

- **스키마 재작성과 데이터 복사**는 여전히 손으로 해야 한다.
- **동시성 차이:** D1 은 한 곳에서 순서대로 쓰기 때문에 지금의 "한 문장 가드" 가 안전하다. PostgreSQL(기본 READ COMMITTED)에서도
  한 문장 UPDATE/INSERT … WHERE 가드는 대체로 같게 동작하지만, 동시에 들어온 두 INSERT … SELECT … WHERE NOT EXISTS 는 **둘 다 성공할 수 있다**
  (예: 기업 등록 두 번 누르기, 초대 한도). 유일 인덱스 추가나 `SERIALIZABLE` 이 필요한지 따로 검토한다 (확인 필요).
  같은 이유로 `options.setOptionActive` 의 "마지막 사용 중 항목은 끄지 않음" 가드도, 서로 다른 두 항목을 동시에 사용 종료하면 둘 다 통과해 그 종류의 사용 중 항목이 0개가 될 수 있다
  (공고 폼의 세 칸은 선택 사항이라 저장은 되지만 고를 것이 없어진다). 옮길 때 `SELECT … FOR UPDATE` 로 그 종류의 행을 잠그거나 `SERIALIZABLE` 로 한다 (확인 필요).
- 새로 만드는 기능(T-06 이후)도 `src/db/` 에만 SQL 을 두어야 이 장점이 유지된다 (CLAUDE.md 작업 방식, 테스트가 검사).
- 백업·복구 절차, 접속 정보(비밀값) 관리, 지역(서울/중국 접속) 선택은 별도로 정해야 한다.

## 5. Oracle 에 대해

Cloudflare Workers 에서 Oracle DB 에 직접 붙는 현실적인 방법은 없다고 본다. Hyperdrive 는 PostgreSQL(과 MySQL) 용이고,
Oracle 드라이버는 Workers 실행 환경을 지원하지 않는다 (확인 필요). Oracle 이 꼭 필요하면 중간에 별도 API 서버를 두어야 하며,
그만큼 구성·비용·지연이 늘어난다. 이 프로젝트의 목표로는 권하지 않는다.
