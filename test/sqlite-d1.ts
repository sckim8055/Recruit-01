// 테스트용: Node 22 의 node:sqlite 를 D1 처럼 쓰는 작은 어댑터 (prepare·bind·first·all·run·batch).
// batch 는 D1 처럼 한 트랜잭션으로 실행한다. node:sqlite 가 없는 Node 에서는 DatabaseSync 가 null — 테스트는 skipIf 로 건너뛴다.
type Sqlite = {
  exec(s: string): void;
  prepare(s: string): { run(...a: unknown[]): { changes: number | bigint }; all(...a: unknown[]): Record<string, unknown>[]; get(...a: unknown[]): Record<string, unknown> | undefined };
};
let Ctor: (new (p: string) => Sqlite) | null = null;
let fs: { readdirSync(p: string): string[]; readFileSync(p: string, e: 'utf8'): string } | null = null;
try {
  const sqliteMod = 'node:sqlite', fsMod = 'node:fs';
  Ctor = ((await import(sqliteMod)) as { DatabaseSync: new (p: string) => Sqlite }).DatabaseSync;
  fs = (await import(fsMod)) as typeof fs;
} catch { /* node:sqlite 없음 */ }

export const hasSqlite = Ctor !== null;

/** migrations/ 를 번호 순서대로 적용한 메모리 DB. */
export function migratedDb(): { raw: Sqlite; d1: D1Database } {
  const raw = new Ctor!(':memory:');
  for (const f of fs!.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) raw.exec(fs!.readFileSync(`migrations/${f}`, 'utf8'));
  const plain = (r: Record<string, unknown>) => ({ ...r });
  interface Stmt { sql: string; b: unknown[] }
  const prepare = (sql: string) => {
    const st = {
      sql, b: [] as unknown[],
      bind: (...x: unknown[]) => { st.b = x; return st; },
      first: async () => { const r = raw.prepare(sql).get(...(st.b as never[])); return r ? plain(r) : null; },
      all: async () => ({ results: raw.prepare(sql).all(...(st.b as never[])).map(plain) }),
      run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(st.b as never[])).changes) } }),
    };
    return st;
  };
  const d1 = {
    prepare,
    batch: async (stmts: Stmt[]) => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(raw.prepare(s.sql).run(...(s.b as never[])).changes) } }));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
  return { raw, d1 };
}
