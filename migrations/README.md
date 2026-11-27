# migrations

- **`pg/` — 지금 쓰는 PostgreSQL 16 스키마 (T-19).** `npm run db:migrate`(scripts/db-migrate.mjs)가 번호 순서대로, 파일 하나 = 트랜잭션 하나로 적용하고 `schema_migrations` 에 남긴다.
  `pg/0001_init.sql` 은 아래 SQLite 파일 0001~0013 을 모두 적용한 결과와 같은 최종 모양이다 (`test/pg-schema.test.ts` 가 비교한다).
  DB 를 바꿀 때는 `pg/0002_<이름>.sql` 처럼 **새 번호 파일을 더하고** `src/db/system.ts` 의 `PG_MIGRATIONS` 에도 적는다. 적용한 파일은 고치지 않는다 (실행기가 지문으로 막는다).
- **`0001_init.sql` ~ `0013_user_totp.sql` — 예전 Cloudflare D1(SQLite) 마이그레이션. 기록으로만 남긴다.** 고치지 않고, 어디에도 적용하지 않는다
  (예전 테스트 서버의 데이터를 가져올 때는 그 서버에서 내보낸 SQL 을 쓴다 — scripts/import-from-cloudflare.mjs). 각 파일의 주석은 컬럼의 뜻을 설명하는 자료로 쓴다.
