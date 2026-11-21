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
| `companies.listPublicCompanies` | `ORDER BY name_ko` = 바이트 순서 | DB 콜레이션에 따라 한글 정렬이 달라질 수 있음 (`COLLATE "C"` 로 맞춤) |

PostgreSQL 에서도 그대로 되는 것(표시하지 않음): `ON CONFLICT … DO UPDATE … excluded`, `EXISTS (…)` 가드, `UPDATE … WHERE … AND EXISTS`,
`ORDER BY 식 = '값' DESC`(참/거짓 정렬), `CASE`, `LIMIT`, `rev = rev + 1`.
`public-jobs.ts` 의 `LIMIT ? OFFSET ?`, `CASE WHEN … END`(ELSE 없으면 NULL)도 그대로 된다. 목록 정렬 `published_at DESC, id DESC` 의 id 는 TEXT 이므로
PostgreSQL 콜레이션에 따라 같은 시각 안의 순서만 달라질 수 있다(페이지가 겹치지 않으려면 `COLLATE "C"` 권장, 확인 필요).
지금 코드는 `datetime()`·`strftime`·`rowid`·`INSERT OR IGNORE/REPLACE`·`LIKE` 를 쓰지 않는다.

## 4. 이 계층으로 쉬워지지 않는 것

- **스키마 재작성과 데이터 복사**는 여전히 손으로 해야 한다.
- **동시성 차이:** D1 은 한 곳에서 순서대로 쓰기 때문에 지금의 "한 문장 가드" 가 안전하다. PostgreSQL(기본 READ COMMITTED)에서도
  한 문장 UPDATE/INSERT … WHERE 가드는 대체로 같게 동작하지만, 동시에 들어온 두 INSERT … SELECT … WHERE NOT EXISTS 는 **둘 다 성공할 수 있다**
  (예: 기업 등록 두 번 누르기, 초대 한도). 유일 인덱스 추가나 `SERIALIZABLE` 이 필요한지 따로 검토한다 (확인 필요).
- 새로 만드는 기능(T-06 이후)도 `src/db/` 에만 SQL 을 두어야 이 장점이 유지된다 (CLAUDE.md 작업 방식, 테스트가 검사).
- 백업·복구 절차, 접속 정보(비밀값) 관리, 지역(서울/중국 접속) 선택은 별도로 정해야 한다.

## 5. Oracle 에 대해

Cloudflare Workers 에서 Oracle DB 에 직접 붙는 현실적인 방법은 없다고 본다. Hyperdrive 는 PostgreSQL(과 MySQL) 용이고,
Oracle 드라이버는 Workers 실행 환경을 지원하지 않는다 (확인 필요). Oracle 이 꼭 필요하면 중간에 별도 API 서버를 두어야 하며,
그만큼 구성·비용·지연이 늘어난다. 이 프로젝트의 목표로는 권하지 않는다.
