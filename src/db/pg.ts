// D1 과 같은 호출 모양(prepare·bind·first·all·run·batch)을 PostgreSQL 위에 만든다 (T-19). src/db/*.ts 는 이 모양만 쓴다.
//
// - 자리표시자: SQL 의 `?` 를 차례대로 `$1, $2, …` 로 바꾼다. 작은따옴표 문자열('…', '' 는 따옴표 하나)·큰따옴표 이름("…")·
//   주석(-- …, /* … */) 안의 `?` 는 바꾸지 않는다.
// - 형: 바인딩한 값이 정수이면 `$n::bigint`, 정수가 아닌 숫자이면 `$n::float8` 로 형을 적는다. PostgreSQL 은 형을 모르는 매개변수를
//   주변 문맥으로 정하는데, `SELECT $1, …`(FROM 없는 SELECT 목록)·`$1 <= $2` 처럼 문맥이 없으면 text 로 정해져
//   숫자 비교가 글자 비교가 되거나 숫자 컬럼에 넣지 못한다 (SQLite·D1 은 값 자체의 형을 쓴다). 문자열·null 은 형을 적지 않는다 —
//   null 이 형을 정할 수 없는 자리(FROM 없는 SELECT 목록 등)는 src/db 의 SQL 에 `CAST(? AS BIGINT)` 처럼 직접 적는다.
//   true/false 는 D1 처럼 1/0 으로 넣는다. undefined 는 D1 처럼 오류다.
// - 결과: bigint(int8)·numeric 은 JS 숫자로 바꾼다 (COUNT(*)·SUM·시각 컬럼). 2^53 을 넘는 값은 이 서비스에 없다.
// - `run().meta.changes` = rowCount, `first(col)` = 첫 행의 그 컬럼, `batch([...])` = BEGIN … COMMIT (하나라도 실패하면 ROLLBACK 후 예외).
//   batch 안의 SELECT 는 results 에 행이 들어간다 (D1 과 같다).
// - 동시성 (docs/DB-PORTING.md 4장): D1 은 모든 쓰기를 한 줄로 차례로 했다. src/db 의 "한 문장 가드"(INSERT … SELECT … WHERE COUNT < n,
//   UPDATE … WHERE id IN (SELECT … LIMIT 1) 등)와 "앞 문장의 결과에 기대는 batch" 는 그 전제로 쓰여 있다.
//   그래서 모든 연결을 **SERIALIZABLE** 로 연다(createPool 의 default_transaction_isolation, batch 의 BEGIN ISOLATION LEVEL SERIALIZABLE).
//   PostgreSQL 은 동시에 돈 트랜잭션들이 어떤 차례로 하나씩 돈 것과 결과가 다르면 한쪽을 40001(serialization_failure)로 실패시킨다 →
//   여기서 같은 문장·batch 를 처음부터 다시 실행한다(최대 RETRY_LIMIT 번, 40P01 교착도 같게). 실패한 쪽은 통째로 되돌려졌으므로 다시 해도 안전하다.
//   결과적으로 D1 처럼 "한 번에 하나씩" 과 같은 결과가 된다. 실제 PostgreSQL 에서의 병렬 시험: test/pg-concurrency.test.ts.
import type { Db, DbResult, DbStatement } from './types';

export interface PgQueryResult { rows: Record<string, unknown>[]; rowCount: number | null; command?: string }

/** 실제로 SQL 을 보내는 쪽. node-postgres 의 Pool(poolBackend) 또는 테스트의 PGlite. */
export interface PgBackend {
  query(text: string, params: unknown[]): Promise<PgQueryResult>;
  /** 문장들을 한 트랜잭션으로. 실패하면 되돌리고 예외. */
  batch(items: Array<{ text: string; params: unknown[] }>): Promise<PgQueryResult[]>;
}

/** 바인딩 값 하나를 정리한다: 형 표시('' = 적지 않음)와 보낼 값. */
function normalize(v: unknown, i: number): { cast: string; value: unknown } {
  if (v === undefined) throw new TypeError(`db: bind value ${i + 1} is undefined`);
  if (v === null) return { cast: '', value: null };
  if (typeof v === 'boolean') return { cast: '::bigint', value: v ? 1 : 0 };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`db: bind value ${i + 1} is not a finite number`);
    return Number.isInteger(v) ? { cast: '::bigint', value: v } : { cast: '::float8', value: v };
  }
  if (typeof v === 'bigint') return { cast: '::bigint', value: v.toString() };
  if (typeof v === 'string') return { cast: '', value: v };
  throw new TypeError(`db: bind value ${i + 1} has unsupported type ${typeof v}`);
}

/**
 * `?` → `$n` (+ 형 표시). 문자열·이름·주석 안은 그대로 둔다. `?` 수와 값 수가 다르면 오류 (D1 도 오류다).
 * 순수 함수 — test/pg-adapter.test.ts.
 */
export function toPgSql(sql: string, values: readonly unknown[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let out = '';
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      // 문자열·이름: 같은 따옴표 두 개는 따옴표 하나. 닫는 따옴표까지 그대로 복사한다.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const j = end < 0 ? sql.length : end;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '?') {
      if (n >= values.length) throw new RangeError(`db: SQL has more placeholders than bound values (${values.length})`);
      const { cast, value } = normalize(values[n], n);
      n++;
      params.push(value);
      out += `$${n}${cast}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (n !== values.length) throw new RangeError(`db: ${values.length} values bound but SQL has ${n} placeholders`);
  return { text: out, params };
}

/** D1 과 같게: SELECT 의 changes 는 0 (node-postgres 의 rowCount 는 SELECT 에서 읽은 행 수다). */
const shape = <T>(r: PgQueryResult): DbResult<T> =>
  ({ results: r.rows as T[], success: true, meta: { changes: r.command === 'SELECT' ? 0 : (r.rowCount ?? 0) } });

class PgStatement implements DbStatement {
  values: unknown[] = [];
  private bound = false;
  constructor(readonly backend: PgBackend, readonly sql: string) {}
  /** 처음 bind 는 이 문장에 값을 넣고 이 문장을 돌려준다. 이미 값이 있으면 새 문장을 만든다 (같은 prepare 를 여러 번 bind 해도 섞이지 않게). */
  bind(...values: unknown[]): DbStatement {
    const s = this.bound ? new PgStatement(this.backend, this.sql) : this;
    s.values = values;
    s.bound = true;
    return s;
  }
  compiled() {
    return toPgSql(this.sql, this.values);
  }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const c = this.compiled();
    const r = await this.backend.query(c.text, c.params);
    const row = r.rows[0];
    if (!row) return null;
    return (col === undefined ? row : (row[col] ?? null)) as T | null;
  }
  private async exec<T>(): Promise<DbResult<T>> {
    const c = this.compiled();
    return shape<T>(await this.backend.query(c.text, c.params));
  }
  all<T = unknown>(): Promise<DbResult<T>> {
    return this.exec<T>();
  }
  run<T = unknown>(): Promise<DbResult<T>> {
    return this.exec<T>();
  }
}

/** D1 모양의 Db. */
export function createDb(backend: PgBackend): Db {
  return {
    prepare: (sql: string) => new PgStatement(backend, sql),
    async batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]> {
      if (!statements.length) return [];
      const items = statements.map((s) => {
        if (!(s instanceof PgStatement) || s.backend !== backend) throw new TypeError('db: batch statement from another database');
        return s.compiled();
      });
      return (await backend.batch(items)).map((r) => shape<T>(r));
    },
  };
}

/** PostgreSQL 오류의 SQLSTATE (없으면 null). 23505 = 유일 제약 위반. */
export const sqlState = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

// ── node-postgres

/** node-postgres Pool 의 필요한 부분 (테스트에서 가짜를 넣기 쉽게). */
export interface PoolLike {
  query(text: string, params: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<PgQueryResult>; release(err?: Error | boolean): void }>;
}

/**
 * 다시 해 볼 오류와 최대 시도 수.
 * - 40001 serialization_failure · 40P01 deadlock_detected: 동시에 돈 트랜잭션과 겹쳤다 → 다시 하면 차례대로 한 것과 같은 결과.
 * - 23505 unique_violation: SERIALIZABLE 에서도 "동시에 넣은 같은 키" 는 40001 이 아니라 23505 로 올 수 있다
 *   (예: 같은 초대를 두 번 동시에 수락 — 앞 문장의 NOT EXISTS 가 아직 커밋되지 않은 행을 못 본다). 다시 하면 가드가 그 행을 보고 아무것도 넣지 않는다
 *   (D1 에서 차례로 한 것과 같은 결과). 진짜 중복(이미 있던 키)은 다시 해도 또 23505 이므로 세 번 만에 그대로 던진다 — 호출부의 처리(insertInviteWithinLimit 의 "중복" 안내 등)는 같다.
 */
export const RETRY_LIMITS: Readonly<Record<string, number>> = { '40001': 8, '40P01': 8, '23505': 3 };
export const RETRY_LIMIT = 8;

/** 다시 해 볼 오류면 조금 기다렸다가 처음부터 다시. 그 밖의 오류·마지막 실패는 그대로 던진다. */
export async function withRetry<T>(fn: () => Promise<T>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = sqlState(e);
      const limit = code ? RETRY_LIMITS[code] : undefined;
      if (!limit || attempt >= limit) throw e;
      await sleep(Math.floor(Math.random() * 10 * attempt) + 2);
    }
  }
}

export function poolBackend(pool: PoolLike): PgBackend {
  return {
    // 한 문장은 그 자체로 하나의 트랜잭션 (연결의 기본 격리 수준 = SERIALIZABLE, createPool).
    query: (text, params) => withRetry(() => pool.query(text, params)),
    batch: (items) => withRetry(() => runBatch(pool, items)),
  };
}

async function runBatch(pool: PoolLike, items: Array<{ text: string; params: unknown[] }>): Promise<PgQueryResult[]> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const out: PgQueryResult[] = [];
    for (const it of items) out.push(await client.query(it.text, it.params));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (re) {
      broken = re instanceof Error ? re : new Error('rollback failed'); // 연결을 버린다
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

/** int8(20)·numeric(1700) → JS 숫자. 그 밖은 node-postgres 기본. */
export const PG_NUMBER_OIDS = [20, 1700] as const;
export const toNumber = (s: string): number => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new RangeError('db: numeric value out of range');
  return n;
};

export interface PgConfig {
  connectionString: string;
  max?: number;
  /** 격리 수준 (기본 serializable — 머리말 "동시성"). 시험에서만 바꾼다. */
  isolation?: 'serializable' | 'read committed';
  /** 연결마다 더 줄 설정 (시험의 search_path 등). */
  extraOptions?: string;
}

/** 서버용 Pool 만들기 (src/server.ts). 접속 문자열(비밀번호 포함)은 로그에 쓰지 않는다. */
export async function createPool(cfg: PgConfig) {
  const pg = (await import('pg')).default;
  const parse = pg.types.getTypeParser.bind(pg.types);
  return new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.max ?? 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    application_name: 'recruit',
    // 모든 트랜잭션을 SERIALIZABLE 로 (위 머리말 "동시성"). 40001 은 poolBackend 가 다시 실행한다.
    options: `-c default_transaction_isolation=${(cfg.isolation ?? 'serializable').replace(' ', '\\ ')}${cfg.extraOptions ? ` ${cfg.extraOptions}` : ''}`,
    // 한 요청이 DB 를 오래 붙잡지 않게 (예약 작업의 한 문장도 이 안에 끝난다).
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        (PG_NUMBER_OIDS as readonly number[]).includes(oid) && format !== 'binary' ? toNumber : parse(oid, format as 'text')) as typeof pg.types.getTypeParser,
    },
  });
}
