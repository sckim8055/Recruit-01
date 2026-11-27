#!/usr/bin/env node
// 가짜 wrangler (T-19 가져오기 시험용). 실제 Cloudflare 에 붙지 않는다.
//   FAKE_D1_SQL   : d1 export 가 돌려줄 SQL 파일
//   FAKE_R2_DIR   : r2 object get 이 읽을 폴더 (<폴더>/<키>)
//   FAKE_WRANGLER_LOG : 받은 인자를 한 줄씩 남길 파일 (선택)
// wrangler 4.166 의 인자 모양만 받는다 (다르면 종료 코드 2).
import { appendFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const a = process.argv.slice(2);
if (process.env.FAKE_WRANGLER_LOG) appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify(a) + '\n');
const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const need = (cond, msg) => { if (!cond) { console.error(`fake-wrangler: ${msg}`); process.exit(2); } };

if (a[0] === 'd1' && a[1] === 'export') {
  need(a[2] && !a[2].startsWith('-'), 'missing database name');
  need(a.includes('--remote'), 'missing --remote');
  need(val('--output'), 'missing --output');
  copyFileSync(process.env.FAKE_D1_SQL, val('--output'));
  console.log('🌀 Executing on remote database (fake) ... Done.');
  process.exit(0);
}
if (a[0] === 'r2' && a[1] === 'object' && a[2] === '--help') {
  console.log('COMMANDS\n  wrangler r2 object get <objectPath>\n  wrangler r2 object put <objectPath>\n  wrangler r2 object delete <objectPath>');
  process.exit(0);
}
if (a[0] === 'r2' && a[1] === 'object' && a[2] === 'get') {
  need(a.includes('--remote'), 'missing --remote');
  const path = a[3] ?? '';
  const slash = path.indexOf('/');
  need(slash > 0, 'objectPath must be bucket/key');
  const key = path.slice(slash + 1);
  const src = join(process.env.FAKE_R2_DIR, ...key.split('/'));
  if (!existsSync(src)) { console.error('The specified key does not exist.'); process.exit(1); }
  copyFileSync(src, val('--file') ?? val('-f'));
  process.exit(0);
}
console.error(`fake-wrangler: unsupported ${a.join(' ')}`);
process.exit(2);
