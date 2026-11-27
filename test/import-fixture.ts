// 가짜 D1 내보내기 만들기 (T-19, test/import.test.ts 용). 예전 SQLite 마이그레이션 0001~0013 을 node:sqlite 메모리 DB 에 적용하고
// 가짜 행을 넣은 뒤, `wrangler d1 export` 와 같은 모양(PRAGMA → CREATE TABLE → INSERT … → CREATE INDEX)의 SQL 글로 내보낸다.
// 암호문·첨부파일은 앱과 같은 함수(lib/crypto·lib/resume-files)로 가짜 키를 써서 만든다. 실제 개인정보는 없다.
import { readdirSync, readFileSync } from 'node:fs';
import { encryptText, importEncKey } from '../src/lib/crypto';
import { encryptFile } from '../src/lib/resume-files';

type Sq = { exec(s: string): void; prepare(s: string): { all(...a: unknown[]): Record<string, unknown>[]; run(...a: unknown[]): unknown } };

export const FAKE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
export const IDS = {
  rfile1: 'rfiles/0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e40', rfile2: 'rfiles/0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e41',
  vdoc: 'vdocs/company/c1/1f0e7b1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b.pdf', missing: 'rfiles/0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e49',
};

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** D1 내보내기 모양의 SQL 글. */
export function dumpSqlite(db: Sq): string {
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  for (const o of objs.filter((x) => x.type === 'table')) {
    out.push(`${String(o.sql)};`);
    for (const r of db.prepare(`SELECT * FROM "${String(o.name)}"`).all()) {
      const cols = Object.keys(r);
      out.push(`INSERT INTO "${String(o.name)}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map((c) => lit(r[c])).join(',')});`);
    }
  }
  for (const o of objs.filter((x) => x.type === 'index')) out.push(`${String(o.sql)};`);
  return out.join('\n') + '\n';
}

export interface Fixture { sql: string; files: Record<string, Uint8Array> }

/** 가짜 테스트 서버 데이터. */
export async function buildFixture(keyB64 = FAKE_KEY): Promise<Fixture> {
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Sq };
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  db.exec(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
           INSERT INTO d1_migrations (name) VALUES ('0001_init.sql'), ('0013_user_totp.sql');`);
  const key = await importEncKey(keyB64);
  const enc = (s: string) => encryptText(key, s);
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
  ins(`INSERT INTO users (id, email, role, created_at, totp_secret, totp_last_step, totp_enabled_at) VALUES ('adm','fake.admin@example.test','admin',1,?,5,1)`, await enc('JBSWY3DPEHPK3PXP'));
  ins(`INSERT INTO users (id, email, role, created_at) VALUES ('s1','fake.seeker@example.test','seeker',2), ('co','fake.co@example.test','company',3)`);
  ins(`INSERT INTO companies (id, name_ko, entity_type, verify_status, verified_at, created_at) VALUES ('c1','가짜전자','kr_entity','verified',5,4)`);
  ins(`INSERT INTO company_members (company_id, user_id, member_role, is_hq, created_at) VALUES ('c1','co','owner',0,4)`);
  ins(`INSERT INTO verification_docs (id, owner_type, owner_id, doc_type, r2_key, review_status, reviewed_by, reviewed_at, created_at) VALUES ('d1','company','c1','biz_cert',?,'approved','adm',5,4)`, IDS.vdoc);
  ins(`INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, title_zh, source_zh, contact_email, localize_status, status, published_at, created_at, updated_at, rev, localize_engine, salary_min)
       VALUES ('j1','c1','co','office','가짜 영업','본문','假','假的','hr@example-corp.test','approved','published',6,5,6,2,'workers_ai',4000)`);
  ins(`INSERT INTO resumes (id, user_id, title, is_default, body, file_r2_key, created_at, updated_at) VALUES ('r1','s1','영업직용',1,?,?,7,7)`, await enc('{"v":1,"name":"가짜 이름"}'), IDS.rfile1);
  ins(`INSERT INTO applications (id, job_id, seeker_id, resume_id, resume_snapshot, file_r2_key, status, status_changed_at, created_at, keep_days)
       VALUES ('a1','j1','s1','r1',?,?,'viewed',9,8,180), ('a2','j1','co','r1',?,?,'submitted',9,8,NULL)`,
    await enc('{"v":1,"name":"가짜 이름"}'), IDS.rfile2, await enc('{"v":1}'), IDS.missing);
  ins(`INSERT INTO application_events (id, application_id, event, actor_id, at) VALUES ('e1','a1','viewed','co',9)`);
  ins(`INSERT INTO consents (id, user_id, type, version, agreed_at) VALUES ('k1','s1','terms','2026-11-01',2), ('k2','s1','privacy','2026-11-01.r0',2)`);
  ins(`INSERT INTO alerts (id, seeker_id, filter_json, frequency, created_at, status, next_due_at, checked_until, optin_at, optin_version, updated_at) VALUES ('al1','s1','{}','daily',2,'active',100,2,2,'v1',2)`);
  ins(`INSERT INTO alert_unsub_tokens (token_hash, alert_id, created_at) VALUES ('h1','al1',3)`);
  ins(`INSERT INTO sessions (id, user_id, created_at, expires_at, mfa) VALUES ('sess1','adm',1,9999999999,1)`);
  ins(`INSERT INTO auth_codes (email, code_hash, expires_at, attempts, last_sent_at) VALUES ('fake.seeker@example.test','x',1,0,1)`);
  ins(`INSERT INTO admin_totp_pending (id, user_id, attempts, expires_at) VALUES ('p1','adm',0,1)`);
  ins(`INSERT INTO totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES ('rc1','adm','hash',NULL,1)`);
  ins(`INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ('public_job_filters','["location"]','adm',10)`);
  ins(`INSERT INTO usage_counters (scope, subject, day, n, updated_at) VALUES ('mail_site','site','2026-11-20',3,10)`);
  ins(`INSERT INTO email_log (id, to_hash, template, result, sent_at) VALUES ('m1','hash','auth_code','sent',1)`);
  ins(`INSERT INTO access_log (id, actor_id, actor_role, target_type, target_id, reason, at) VALUES ('l1','co','company','application','a1',NULL,9)`);
  // 관리자가 고친 기본 항목 하나 (이름·순서·사용 종료)
  ins(`UPDATE job_options SET label_ko = '무역·수출입', sort = 5, active = 0, updated_by = 'adm', updated_at = 11 WHERE kind = 'industry' AND code = 'trade'`);
  ins(`INSERT INTO job_options (kind, code, label_ko, label_zh, sort, active, created_at, updated_at, updated_by) VALUES ('industry','semiconductor','반도체','半导体',170,1,11,11,'adm')`);
  const k = await importEncKey(keyB64);
  const files: Record<string, Uint8Array> = {
    [IDS.rfile1]: await encryptFile(k, new TextEncoder().encode('%PDF-1.4 resume'), IDS.rfile1),
    [IDS.rfile2]: await encryptFile(k, new TextEncoder().encode('%PDF-1.4 application'), IDS.rfile2),
    [IDS.vdoc]: new TextEncoder().encode('%PDF-1.4 biz cert'),
  };
  return { sql: dumpSqlite(db), files };
}
