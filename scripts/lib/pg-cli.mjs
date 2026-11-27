// 운영자 스크립트의 PostgreSQL 도구 (T-19): .env 의 DATABASE_URL 로 붙는다. 접속 문자열·비밀번호는 출력하지 않는다.
// 실행은 node --env-file=.env scripts/… (npm run … 이 그렇게 부른다).
import pg from 'pg';

const toNumber = (s) => Number(s);

/** DATABASE_URL 이 없으면 한국어 안내와 함께 끝낸다. */
export function databaseUrl() {
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (!url) {
    console.error('\n[X] .env 에 DATABASE_URL 이 없습니다. docs/DEPLOY.md 3장을 보세요. (npm run … 으로 실행했는지도 확인하세요 — .env 를 읽습니다.)\n');
    process.exit(1);
  }
  return url;
}

/** bigint·numeric 을 숫자로 받는 클라이언트 (서버의 src/db/pg.ts 와 같다). */
export async function connect(url = databaseUrl()) {
  const client = new pg.Client({
    connectionString: url,
    application_name: 'recruit-script',
    types: { getTypeParser: (oid, format) => (oid === 20 || oid === 1700) && format !== 'binary' ? toNumber : pg.types.getTypeParser(oid, format) },
  });
  try {
    await client.connect();
  } catch (e) {
    console.error(`\n[X] PostgreSQL 에 연결하지 못했습니다 (${e?.code ?? 'error'}). PostgreSQL 서비스가 켜져 있는지, .env 의 DATABASE_URL 이 맞는지 확인하세요.\n`);
    process.exit(1);
  }
  return client;
}

/** 접속 문자열 → pg_dump 등에 넘길 환경 변수 (명령줄에 비밀번호가 보이지 않게). */
export function pgEnvOf(url) {
  const u = new URL(url);
  const out = {};
  if (u.hostname) out.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) out.PGPORT = u.port;
  if (u.username) out.PGUSER = decodeURIComponent(u.username);
  if (u.password) out.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) out.PGDATABASE = db;
  const ssl = u.searchParams.get('sslmode');
  if (ssl) out.PGSSLMODE = ssl;
  return out;
}

/** 파일 글의 지문 (줄 끝 CRLF/LF 차이는 무시 — Windows 에서 git 이 줄 끝을 바꿔도 같은 파일로 본다). */
export async function checksum(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}
