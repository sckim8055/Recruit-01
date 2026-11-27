// DB 호출의 모양 (T-19). Cloudflare D1 의 prepare·bind·first·all·run·batch 와 같은 부분만 둔다 — src/db/*.ts 의 호출 방식을 그대로 두기 위해서다.
// 구현은 src/db/pg.ts (PostgreSQL, node-postgres). 테스트는 같은 pg.ts 를 PGlite 위에서 쓴다 (test/pg-test-db.ts).

export interface DbMeta {
  /** 영향 행 수 (INSERT·UPDATE·DELETE). SELECT 는 0. */
  changes: number;
}

export interface DbResult<T = unknown> {
  results: T[];
  success: true;
  meta: DbMeta;
}

export interface DbStatement {
  /** 자리표시자 `?` 에 넣을 값 (순서대로). 숫자·문자열·null 만 쓴다. */
  bind(...values: unknown[]): DbStatement;
  /** 첫 행 (없으면 null). col 을 주면 그 컬럼 값. */
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<DbResult<T>>;
  run<T = unknown>(): Promise<DbResult<T>>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** 문장들을 **한 트랜잭션**으로 순서대로 실행한다. 하나라도 실패하면 모두 되돌리고 예외를 던진다. */
  batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]>;
}
