# DB 이전 기록 (SQLite/D1 → PostgreSQL 16, T-19 완료)

T-19 에서 Cloudflare D1(SQLite)을 운영자 PC 의 **PostgreSQL 16** 으로 옮겼다. 이 문서는 (1) 지금 DB 코드가 어떻게 되어 있는지, (2) 옮기기 전에 이 문서가 예상한 것과
**실제로 해 보니 달랐던 것**, (3) 동시성 판단과 실제 PostgreSQL 에서의 병렬 시험 결과를 적는다. 예전 판의 "확인 필요" 는 모두 아래에서 결과로 바꿨다.

## 1. DB 코드가 있는 곳

- **모든 SQL 과 DB 호출은 `src/db/` 에만 있다** (T-05d). 라우트·lib 는 `env.DB` 를 이 폴더의 함수에 넘기기만 한다. `test/db-layer.test.ts` 가 검사한다.
- 호출 모양은 D1 그대로다: `db.prepare(sql).bind(...).first() / all() / run()`, `db.batch([...])`. 함수 이름·인자·돌려주는 값을 바꾸지 않았다 → 라우트는 고치지 않았다.

| 파일 | 하는 일 (T-19 에서 새로 생김) |
|---|---|
| `src/db/types.ts` | `Db` · `DbStatement` · `DbResult` — D1 과 같은 모양 (예전 `D1Database` 등 Cloudflare 타입 대신) |
| `src/db/pg.ts` | D1 모양 어댑터: `?` → `$n`(+ 숫자 형 표시), `run().meta.changes` = rowCount(SELECT 는 0), `first(col)`, `batch` = `BEGIN ISOLATION LEVEL SERIALIZABLE … COMMIT`, 직렬화 실패 다시 실행, node-postgres Pool(`createPool`) |
| `src/db/locks.ts` | PostgreSQL 권고 잠금 (예약 작업·자동 백업이 두 프로세스에서 동시에 돌지 않게) |
| `src/db/system.ts` | `/admin/system` 의 DB 연결·적용된 마이그레이션 읽기, `PG_MIGRATIONS` 목록 |

각 파일 안의 `[sqlite]` 주석은 옮기기 전에 쓴 메모다 — 결과는 이 문서 2·4장이 기준이다. 예전 표(파일 → 다루는 표)는 바뀌지 않았다: users · sessions · twofa · companies · jobs · public-jobs · logs · admin · settings · resumes · options · applications · application-views ·
applicants · consents · account · maintenance · usage · alerts · applicant-views · demo (각 파일 머리말 참고).

- 스키마: **`migrations/pg/0001_init.sql`** (SQLite 0001~0013 을 적용한 결과와 같은 최종 모양 한 파일). 적용은 `npm run db:migrate`(scripts/db-migrate.mjs, `schema_migrations` 표).
  예전 `migrations/0001~0013.sql` 은 기록으로만 남는다 (migrations/README.md). 새 변경은 `migrations/pg/0002_….sql` 처럼 더한다.
- 테스트: `test/pg-test-db.ts` — PGlite(WASM PostgreSQL)에 `migrations/pg/*` 를 적용하고 **서버와 같은 `createDb`** 로 감싼다 (예전 `test/sqlite-d1.ts` 대신).
  동시성은 PGlite 로 시험할 수 없어(연결 하나) `test/pg-concurrency.test.ts` 가 실제 PostgreSQL(`PG_TEST_URL`)로 한다.

## 2. 예상과 실제 (예전 판 2·3장의 항목별)

| 예전 판의 예상 | 실제 (T-19) |
|---|---|
| `src/db/*` 를 PostgreSQL 드라이버로 다시 쓴다 | **다시 쓰지 않았다.** D1 모양 어댑터(`src/db/pg.ts`)를 만들고 SQL 문법만 고쳤다. 고친 문장은 아래 "고친 SQL" 표의 6곳뿐 |
| `?` → `$1…` | 어댑터가 바꾼다. 작은따옴표 문자열(`''` 포함)·큰따옴표 이름·`--`·`/* */` 주석 안의 `?` 는 그대로 (test/pg-adapter.test.ts) |
| FROM 없는 SELECT 목록의 매개변수에 `$n::integer` 가 필요할 수 있다 (확인 필요) | **필요했다 — 더 넓게.** 형이 없는 매개변수는 문맥이 없으면 text 가 된다: `INSERT … SELECT ?, …` 의 숫자 컬럼은 오류, `WHERE ? <= ?`(takeQuota)는 **글자 비교**('4' <= '10' 이 거짓)가 된다. → 어댑터가 정수 값이면 `$n::bigint`, 소수면 `$n::float8` 를 붙인다 (값의 형으로 — D1 과 같은 뜻). 문자열·null 은 붙이지 않는다 |
| null 매개변수 | `? IS NULL`(listAccessLog)은 "could not determine data type of parameter" → SQL 을 `CAST(? AS BIGINT) IS NULL` · `CAST(? AS TEXT) IS NULL` 로 고쳤다. 그 밖의 null 은 문맥(컬럼·CASE·COALESCE)으로 형이 정해져 고칠 곳이 없었다 |
| `batch` → BEGIN … COMMIT, 순서 그대로 | 그대로. 다만 격리 수준을 **SERIALIZABLE** 로 했다 (4장) |
| `meta.changes` → rowCount | 그대로. 단 node-postgres 는 SELECT 의 rowCount 에 읽은 행 수를 준다 → D1 처럼 SELECT 는 0 으로 맞췄다 |
| bigint 는 문자열로 올 수 있다 (확인 필요) | 맞다 (int8·numeric). Pool 의 형 변환으로 **숫자로 받는다** (`COUNT(*)`·`SUM`·시각 컬럼). `adminCounts` 는 `Number()` 없이 쓰고 있었는데 이 설정 덕분에 고치지 않았다 |
| 시각 컬럼 `integer` 는 2038년에 넘친다 → `bigint` | 정수 컬럼을 **모두 BIGINT** 로 했다 (0/1 값 포함) |
| 0/1 값을 boolean 으로 바꿀지 | **INTEGER(BIGINT) 0/1 그대로** — 코드 변경 없음 (is_hq · mfa · is_default · active · company_name_public) |
| `MIN(a, b)` → `LEAST` | 고쳤다 (`maintenance.ts` effKeep·autoCloseBeforeSql) |
| `lower(hex(randomblob(16)))` → `gen_random_uuid()` | `replace(gen_random_uuid()::text, '-', '')` 로 — 예전과 같은 **하이픈 없는 32자** 모양 (account.eraseUser · maintenance.autoCloseStmts · demo 동의 행) |
| `ON CONFLICT … DO UPDATE … excluded` 는 그대로 된다 | 한 곳 달랐다: `demo.ts` 의 `rev = rev + 1` 은 PostgreSQL 에서 "rev 가 모호하다" 오류 → `rev = jobs.rev + 1` |
| UNIQUE 위반 판별 (SQLSTATE 23505) | `insertApplication` 은 메시지의 "UNIQUE"(대소문자 무시)로 판별하는데 PostgreSQL 메시지 `violates unique constraint` 에도 맞아 그대로 된다. 게다가 동시 두 지원은 어댑터의 다시 실행으로 예외 대신 false 가 된다 (4장) |
| `ORDER BY name_ko` 콜레이션 | 글자 컬럼을 모두 `COLLATE "C"`(바이트 순서 = SQLite BINARY)로 만들었다 — 정렬·`key < ?`·`day < ?` 비교가 예전과 같다 |
| `x IN (SELECT … LIMIT ?)`, 행 값 IN, `COUNT(*) OVER ()`, `RETURNING`, `substr` | 그대로 된다 (고치지 않음) |
| 읽기 batch | 그대로 (한 트랜잭션 안의 SELECT 들) |
| D1 바인딩 한도 100 → IN 목록 50개씩 | 그대로 둔다 (PostgreSQL 한도는 65535 — 필요하면 나중에 `= ANY($1)`) |
| Hyperdrive 로 Worker 에서 PostgreSQL | 쓰지 않았다 — Worker 를 버리고 Node 서버로 옮겼다 |
| 데이터 복사: export → 표마다 넣기 → 행 수 비교 | `scripts/import-from-cloudflare.mjs` (6장). 가짜 내보내기로만 시험했다 |

**고친 SQL (src/db, 6곳):** `maintenance.ts` LEAST 2 · randomblob 1 / `account.ts` randomblob 1 / `demo.ts` randomblob 1 · `jobs.rev` 1 / `applicants.listAccessLog` CAST 2.
문장 순서·가드·판단은 하나도 바꾸지 않았다.

## 3. 스키마 (migrations/pg/0001_init.sql)

- 표·컬럼(순서 포함)·NOT NULL·기본값·기본 키·외래키(ON DELETE CASCADE 2곳: alert_unsub_tokens → alerts, totp_enrolments·totp_recovery_codes → users/sessions)·CHECK 개수·이름 붙은 인덱스(부분 유일 `idx_resumes_default`·`idx_company_invites_email` 포함)·
  job_options 기본 49행이 SQLite 결과와 같은지 **`test/pg-schema.test.ts` 가 표마다 비교한다** (node:sqlite 로 예전 파일을 적용해 읽음).
- 차이: 정수 → BIGINT, 글자 → TEXT COLLATE "C", SQLite 에서 NULL 이 들어갈 수 있던 `TEXT PRIMARY KEY` 는 PostgreSQL 에서 NOT NULL(기본 키) — 앱은 늘 id 를 넣는다.
  job_options 기본 행의 시각은 `extract(epoch from now())::bigint`.
- `schema_migrations(name, checksum, applied_at)`: 실행기가 만든다. 이미 적용한 파일의 내용이 바뀌면(줄 끝 CRLF/LF 차이는 무시) 멈춘다.

## 4. 동시성 (READ COMMITTED 로 옮겼다면 → 실제로 한 것)

D1 은 모든 쓰기를 한 줄로 차례로 했다. `src/db` 의 가드는 그 전제로 쓰여 있다. PostgreSQL 의 기본(READ COMMITTED)은 문장마다 스냅샷을 새로 잡고,
`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < n` 같은 "센 다음 넣기" 를 서로 보지 못한 채 동시에 통과시킨다.

**결정:** 모든 연결을 **SERIALIZABLE** 로 연다 (`createPool` 의 `default_transaction_isolation=serializable`, batch 는 `BEGIN ISOLATION LEVEL SERIALIZABLE`).
PostgreSQL 은 동시에 돈 트랜잭션들이 어떤 차례로 하나씩 돈 것과 다른 결과가 되면 한쪽을 `40001` 로 실패시키고, 어댑터가 **그 문장·batch 를 처음부터 다시 실행**한다(최대 8번, `40P01` 교착도).
`23505`(유일 위반)도 3번까지 다시 한다 — SERIALIZABLE 에서도 "동시에 넣은 같은 키" 는 40001 이 아니라 23505 로 오는 경우가 있었다(아래 acceptInvite). 다시 하면 가드가 커밋된 행을 보고 아무것도 넣지 않는다.
진짜 중복은 다시 해도 23505 라서 그대로 던진다(호출부 처리 같음). → 결과가 D1 의 "한 번에 하나씩" 과 같다. 비용: 겹칠 때만 다시 실행(이 서비스 규모에서는 드묾).

시험: `test/pg-concurrency.test.ts` — 실제 PostgreSQL 16.15 에 연결 12개로 같은 함수를 동시에 부른다. "RC" 열은 같은 시험을 `PG_TEST_ISOLATION='read committed'` 로 5번 돌린 결과(비교용).

| 가드 (src/db) | 모양 | READ COMMITTED 였다면 (실측 5회) | 지금 (SERIALIZABLE + 다시 실행, 실측 8회) |
|---|---|---|---|
| `usage.takeQuota` | `INSERT … SELECT … WHERE cost <= limit ON CONFLICT DO UPDATE … WHERE n + cost <= limit` | 통과 5/5 (ON CONFLICT 가 최신 행을 잠그고 WHERE 를 다시 본다) | 통과 — 한도 5 에 12번 → 정확히 5 |
| `twofa.useRecoveryCode` | `UPDATE … WHERE id IN (SELECT id … used_at IS NULL LIMIT 1)` | **실패 5/5** — 같은 복구 코드를 여러 요청이 씀 (다시 확인하는 조건이 바깥 WHERE 가 아니라 서브쿼리 안에 있다) | 통과 — 2줄이면 정확히 2번 |
| `users.useTotpStep` | `UPDATE … WHERE totp_last_step < ?` | 통과 5/5 (바깥 WHERE 를 다시 본다) | 통과 — 1번 |
| `sessions.consumeTotpPending` | `DELETE WHERE id = ?` | 통과 5/5 | 통과 — 1번 |
| `twofa.takeTotpTry` | `UPDATE … CASE … WHERE (fresh OR count < max)` | 통과 5/5 | 통과 — 5번 |
| `applications.insertApplication` | `INSERT … SELECT … WHERE 공개 AND NOT EXISTS` + `UNIQUE(job_id, seeker_id)` + 동의 | 통과 5/5 (유일 제약) | 통과 — 1건·동의 1줄, 예외 대신 false |
| `applicants.markViewed` · `recordMailEvent` · `applications.withdrawApplication` | 이벤트 `INSERT … SELECT … WHERE status = ?` → 상태 `UPDATE` | 통과 5/5 (이번 실측에서는 겹치지 않음 — 이론상 이벤트가 두 줄 생길 수 있다) | 통과 — 이벤트·상태 한 번씩 |
| `resumes.insertResume` | `INSERT … SELECT … WHERE (SELECT COUNT(*)) < 5` | **실패 5/5** — 6개 이상 | 통과 — 5개, 대표 1개 |
| `jobs.insertJob` (초안 한도) | 같은 모양 | **실패 5/5** | 통과 — 3개 |
| `jobs.claimLocalize` | `UPDATE … WHERE localize_requested_at <= ?` | 통과 5/5 | 통과 — 1번 |
| `alerts.insertAlert` | `WHERE COUNT < 5 AND NOT EXISTS (같은 조건)` | **실패 5/5** | 통과 — 5개, 같은 조건 1개 |
| `companies.insertInviteWithinLimit` | `WHERE 담당자 + 초대 < 자리` | **실패 5/5** | 통과 — 2건 |
| `companies.registerCompany` | 두 문장 `WHERE NOT EXISTS (그 사람의 소속)` | 통과 5/5 (23505 다시 실행 덕분) | 통과 — 기업 1·소속 1 |
| `companies.acceptInvite` | `INSERT … WHERE NOT EXISTS (소속)` | 통과 5/5 | 통과 — 처음에는 **SERIALIZABLE 에서도 23505 예외**(같은 초대를 동시에 수락) → 23505 다시 실행을 더해 해결 |
| `options.setOptionActive` | `WHERE (SELECT COUNT(*) … active = 1) > 1` | **실패 5/5** — 마지막 항목까지 꺼짐 (예전 판이 예상한 그대로) | 통과 — 1개 남음 |
| `consents.insertConsents` | `INSERT … WHERE NOT EXISTS (같은 판)` | 통과 5/5 | 통과 — 2줄 |
| 예약 작업 (`runMaintenance`) | 프로세스 사이 | — | 권고 잠금(`db/locks`): 동시에 4번 → 1번만, 실행 중 최대 1 |

시험하지 않은 것 (판단만): `account.eraseUser`(마지막 문장의 `status != 'deleted'` + SERIALIZABLE), `twofa.saveEnrolment`·`replaceRecoveryCodes`·`disableTotp`·`resetMemberTotp`·`users.confirmTotp`(첫 문장의 비밀키 가드 + 뒤 문장 EXISTS — SERIALIZABLE 이면 차례대로와 같다),
`maintenance` 의 batch(예약 작업은 잠금으로 하나만, 사용자 요청과 겹치면 40001 → 다시 실행), `alerts.recordAlertSent`·`recordAlertsSkipped`(보내는 쪽은 예약 작업 하나뿐 — 같은 알림을 두 번 보내는 "발송 잡기" 문장은 따로 없다; 잠금이 막는다).

**T-19 전부터 있던 것 (바꾸지 않음):** 인증코드·로그인 2단계의 시도 수는 "읽고 비교한 뒤 +1" 이 다른 문장이라, 같은 코드로 동시에 많이 보내면 5번보다 조금 더 시도할 수 있다 (D1 도 문장 단위로만 차례였으므로 같다). TASKS T-16 남은 일.

**스크립트:** `scripts/*.mjs`(마이그레이션·가져오기)는 자기 연결(기본 격리 수준)을 쓴다 — 가져오기는 한 트랜잭션·한 번 실행이고 서버를 멈추고 하기를 권한다 (DEPLOY 6장).

## 5. 시험 방법

- `npm test` — PGlite 로 전체 (PG_TEST_URL 이 없으면 동시성·가져오기 명령 시험은 건너뛴다).
- `PG_TEST_URL=postgres://postgres@127.0.0.1:5433/postgres npm test` — 실제 PostgreSQL 로 동시성(새 스키마를 만들고 지움)·가져오기 명령 전체(새 DB 를 만들고 지움)까지.
- 비교 실험: `PG_TEST_ISOLATION='read committed'` 를 더하면 4장의 RC 열을 다시 볼 수 있다 (실패가 나는 것이 정상).

## 6. Oracle 에 대해

이 프로젝트의 목표로는 권하지 않는다 (예전 판과 같음). PostgreSQL 로 옮긴 지금은 더 이유가 없다.
