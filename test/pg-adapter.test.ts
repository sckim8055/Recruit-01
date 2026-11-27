// D1 모양 어댑터 (T-19, src/db/pg.ts): 자리표시자 바꾸기, batch = 한 트랜잭션(실패하면 모두 되돌림), 영향 행 수, first(col), 다시 실행 규칙.
import { describe, expect, it } from 'vitest';
import { createDb, poolBackend, RETRY_LIMITS, sqlState, toNumber, toPgSql, withRetry, type PgQueryResult } from '../src/db/pg';
import { migratedDb } from './pg-test-db';

describe('toPgSql: ? → $n', () => {
  it('순서대로 바꾸고, 정수는 ::bigint · 소수는 ::float8 · 문자열·null 은 형을 적지 않는다', () => {
    expect(toPgSql('SELECT ?, ?, ?, ? WHERE a = ?', [1, 'x', null, 1.5, true])).toEqual({
      text: 'SELECT $1::bigint, $2, $3, $4::float8 WHERE a = $5::bigint', params: [1, 'x', null, 1.5, 1],
    });
  });
  it('작은따옴표 문자열·큰따옴표 이름·주석 안의 ? 는 그대로', () => {
    const sql = `SELECT '?', 'it''s ?', "we?ird" FROM t -- a ? here\nWHERE x = ? /* ? */ AND y = '?'`;
    const r = toPgSql(sql, ['v']);
    expect(r.text).toBe(`SELECT '?', 'it''s ?', "we?ird" FROM t -- a ? here\nWHERE x = $1 /* ? */ AND y = '?'`);
    expect(r.params).toEqual(['v']);
  });
  it('자리 수와 값 수가 다르면 오류, undefined·객체는 오류 (D1 과 같다)', () => {
    expect(() => toPgSql('SELECT ?', [])).toThrow();
    expect(() => toPgSql('SELECT 1', [1])).toThrow();
    expect(() => toPgSql('SELECT ?', [undefined])).toThrow();
    expect(() => toPgSql('SELECT ?', [{ a: 1 }])).toThrow();
    expect(() => toPgSql('SELECT ?', [Number.NaN])).toThrow();
  });
  it('bigint 값은 글자로 보내고 ::bigint', () => expect(toPgSql('SELECT ?', [10n])).toEqual({ text: 'SELECT $1::bigint', params: ['10'] }));
});

describe('어댑터 (PGlite, 서버와 같은 createDb)', () => {
  it('run().meta.changes = 영향 행 수, first(), first(col), all().results', async () => {
    const { d1 } = migratedDb();
    await d1.prepare("INSERT INTO users (id, email, role, created_at) VALUES (?,?,?,?), (?,?,?,?)").bind('u1', 'a@x.test', 'seeker', 1, 'u2', 'b@x.test', 'seeker', 2).run();
    expect((await d1.prepare("UPDATE users SET locale = 'zh' WHERE created_at >= ?").bind(1).run()).meta.changes).toBe(2);
    expect((await d1.prepare("UPDATE users SET locale = 'zh' WHERE id = ?").bind('nobody').run()).meta.changes).toBe(0);
    expect(await d1.prepare('SELECT id, created_at FROM users WHERE id = ?').bind('u2').first()).toEqual({ id: 'u2', created_at: 2 });
    expect(await d1.prepare('SELECT email FROM users WHERE id = ?').bind('u1').first('email')).toBe('a@x.test');
    expect(await d1.prepare('SELECT 1 FROM users WHERE id = ?').bind('zz').first()).toBeNull();
    expect((await d1.prepare('SELECT COUNT(*) AS n, SUM(created_at) AS s FROM users').all<{ n: number; s: number }>()).results).toEqual([{ n: 2, s: 3 }]);
  });

  it('batch: 한 트랜잭션 — 중간에 실패하면 앞 문장도 되돌리고 예외', async () => {
    const { d1, raw } = migratedDb();
    await expect(d1.batch([
      d1.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1','a@x.test','seeker',0)"),
      d1.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u2','a@x.test','seeker',0)"), // 같은 이메일 → 유일 제약
    ])).rejects.toThrow();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(0);
    const res = await d1.batch([
      d1.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u1','a@x.test','seeker',0)"),
      d1.prepare('SELECT id FROM users'),
      d1.prepare("UPDATE users SET locale = 'zh' WHERE id = 'u1'"),
    ]);
    expect(res.map((r) => r.meta.changes)).toEqual([1, 0, 1]); // SELECT 는 0 (D1 과 같다)
    expect(res[1]!.results).toEqual([{ id: 'u1' }]);
    expect(await d1.batch([])).toEqual([]);
  });

  it('같은 prepare 를 두 번 bind 해도 값이 섞이지 않는다', async () => {
    const { d1 } = migratedDb();
    const st = d1.prepare("INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'seeker', 0)");
    await d1.batch([st.bind('u1', 'a@x.test'), st.bind('u2', 'b@x.test')]);
    expect((await d1.prepare('SELECT id FROM users ORDER BY id').all()).results).toEqual([{ id: 'u1' }, { id: 'u2' }]);
  });

  it('다른 DB 의 문장을 batch 에 넣으면 오류', async () => {
    const a = migratedDb().d1, b = migratedDb().d1;
    await expect(a.batch([b.prepare('SELECT 1')])).rejects.toThrow();
  });

  it('FROM 없는 SELECT 목록의 숫자도 숫자 컬럼에 들어간다 (형 표시 덕분)', async () => {
    const { d1, raw } = migratedDb();
    await d1.prepare("INSERT INTO users (id, email, role, created_at) SELECT ?, ?, 'seeker', ? WHERE ? <= ?").bind('u1', 'a@x.test', 7, 4, 10).run();
    // 글자 비교였다면 '4' <= '10' 이 거짓이라 넣지 않았을 것이다
    expect(raw.prepare('SELECT created_at FROM users').get()).toEqual({ created_at: 7 });
  });
});

describe('poolBackend (가짜 Pool): 트랜잭션·다시 실행', () => {
  type Call = string;
  function fakePool(script: Array<{ match: RegExp; fail?: string }> = []) {
    const calls: Call[] = [];
    const run = async (text: string): Promise<PgQueryResult> => {
      calls.push(text);
      const f = script.find((s) => s.match.test(text) && s.fail);
      if (f) {
        script.splice(script.indexOf(f), 1);
        throw Object.assign(new Error('fake'), { code: f.fail });
      }
      return { rows: [], rowCount: 1 };
    };
    const released: unknown[] = [];
    return {
      calls, released,
      pool: { query: run, connect: async () => ({ query: (t: string) => run(t), release: (e?: unknown) => { released.push(e); } }) },
    };
  }

  it('batch = BEGIN ISOLATION LEVEL SERIALIZABLE … COMMIT, 실패하면 ROLLBACK', async () => {
    const f = fakePool([{ match: /bad/, fail: '22P02' }]);
    const db = createDb(poolBackend(f.pool));
    await db.batch([db.prepare('INSERT good'), db.prepare('UPDATE good')]);
    expect(f.calls).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'INSERT good', 'UPDATE good', 'COMMIT']);
    f.calls.length = 0;
    await expect(db.batch([db.prepare('INSERT good'), db.prepare('INSERT bad')])).rejects.toThrow('fake');
    expect(f.calls).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'INSERT good', 'INSERT bad', 'ROLLBACK']);
    expect(f.released.every((x) => x === undefined)).toBe(true);
  });

  it('40001 은 처음부터 다시 실행, 23505 는 세 번까지, 그 밖의 오류는 바로', async () => {
    const f = fakePool([{ match: /x/, fail: '40001' }, { match: /x/, fail: '40001' }]);
    const db = createDb(poolBackend(f.pool));
    await db.batch([db.prepare('INSERT x')]);
    expect(f.calls.filter((c) => c === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length).toBe(3);
    const g = fakePool([{ match: /u/, fail: '23505' }, { match: /u/, fail: '23505' }, { match: /u/, fail: '23505' }]);
    await expect(createDb(poolBackend(g.pool)).prepare('INSERT u').run()).rejects.toMatchObject({ code: '23505' });
    expect(g.calls.length).toBe(RETRY_LIMITS['23505']);
    const h = fakePool([{ match: /z/, fail: '42601' }]);
    await expect(createDb(poolBackend(h.pool)).prepare('SELECT z').run()).rejects.toMatchObject({ code: '42601' });
    expect(h.calls.length).toBe(1);
  });

  it('withRetry: 한도에서 멈춘다', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw Object.assign(new Error('s'), { code: '40001' }); }, async () => {})).rejects.toThrow();
    expect(n).toBe(RETRY_LIMITS['40001']);
  });

  it('SELECT 의 changes 는 0 (node-postgres 는 읽은 행 수를 rowCount 로 준다)', async () => {
    const pool = { query: async () => ({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2, command: 'SELECT' }), connect: async () => { throw new Error('x'); } };
    expect((await createDb(poolBackend(pool)).prepare('SELECT a').all()).meta.changes).toBe(0);
  });

  it('sqlState · toNumber', () => {
    expect([sqlState({ code: '23505' }), sqlState(new Error('x')), sqlState({ code: 'ECONNREFUSED' })]).toEqual(['23505', null, null]);
    expect(toNumber('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toNumber('12.5')).toBe(12.5);
  });
});
