// DB 접근 계층 경계 검사 (T-05d). SQL 과 D1 호출은 src/db/ 에만 둔다 — 나중에 PostgreSQL 로 옮길 때 고칠 곳을 한 폴더로 묶기 위해서다.
// 규칙 (src/db/ 밖의 .ts·.tsx 파일):
//   1) `.prepare(` · `.batch(` · `meta.changes` 를 쓰지 않는다.
//   2) `env.DB` 는 src/db 함수의 인자로 넘길 때만 쓴다. 텍스트 규칙: `env.DB` 바로 뒤가 `,` 또는 `)` 여야 한다
//      (`const db = c.env.DB` 처럼 변수에 담거나 `env.DB.xxx` 로 직접 부르는 것은 실패).
//   3) SQL 문장(SELECT … FROM, INSERT INTO, UPDATE … SET, DELETE FROM)을 문자열로 두지 않는다.
// 예외 목록 (파일 → 이유). 지금은 없다. 꼭 필요하면 이유와 함께 여기에 적고 docs/DB-PORTING.md 에도 적는다.
import { describe, expect, it } from 'vitest';

const ALLOWED: Record<string, string> = {};

interface Fs {
  readdirSync(p: string, o: { recursive: true }): string[];
  readFileSync(p: string, enc: 'utf8'): string;
}

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  // 테스트 설정(tsconfig types)에 node 타입이 없어 동적 import 로 읽는다.
  const mod = 'node:fs';
  const fs = (await import(mod)) as Fs;
  return fs.readdirSync('src', { recursive: true })
    .map((p) => `src/${p.replace(/\\/g, '/')}`)
    .filter((p) => /\.tsx?$/.test(p))
    .map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
}

const RULES: { name: string; re: RegExp }[] = [
  { name: '.prepare(', re: /\.prepare\s*\(/ },
  { name: '.batch(', re: /\.batch\s*\(/ },
  { name: 'meta.changes', re: /\bmeta\.changes\b/ },
  { name: 'env.DB 를 인자 외로 사용', re: /\benv\.DB\b(?!\s*[,)])/ },
  { name: 'SQL 문자열', re: /\b(SELECT\s[^;]*?\sFROM|INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/ },
];

describe('DB 접근 계층 (src/db/)', () => {
  it('src/db/ 밖에는 SQL·D1 직접 호출이 없다', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const f of files) {
      if (f.path.startsWith('src/db/') || f.path in ALLOWED) continue;
      f.text.split('\n').forEach((line, i) => {
        for (const r of RULES) if (r.re.test(line)) bad.push(`${f.path}:${i + 1} [${r.name}] ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('src/db/ 안에 실제로 DB 코드가 있다 (검사 대상 경로가 맞는지)', async () => {
    const files = await sourceFiles();
    const db = files.filter((f) => f.path.startsWith('src/db/'));
    expect(db.length).toBeGreaterThan(0);
    expect(db.some((f) => /\.prepare\s*\(/.test(f.text))).toBe(true);
  });

  it('보호 파일(rules·authz·crypto·totp)에는 DB 코드가 없다', async () => {
    const files = await sourceFiles();
    for (const p of ['src/lib/rules.ts', 'src/lib/authz.ts', 'src/lib/crypto.ts', 'src/lib/totp.ts']) {
      const f = files.find((x) => x.path === p);
      expect(f, p).toBeDefined();
      expect(/\benv\.DB\b|\.prepare\s*\(|\.batch\s*\(|\.\.\/db\//.test(f!.text), p).toBe(false);
    }
  });
});
