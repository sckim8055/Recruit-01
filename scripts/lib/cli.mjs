// 운영자 스크립트의 공통 도구 (T-13, T-19): 프로젝트 폴더, tsc·vitest·wrangler(가져오기 한 번만) 실행, 물어보기, 비밀문구 입력(화면에 보이지 않게).
// Windows(PowerShell·cmd)와 mac/linux 에서 같게 돈다: 셸을 거치지 않고 Node 로 각 도구의 진입 파일을 직접 실행한다
// (경로에 공백·한글이 있어도 따옴표 문제가 없다). 새 npm 패키지는 쓰지 않는다.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = (...p) => join(ROOT, 'node_modules', ...p);


function runNode(entry, args, opts = {}) {
  if (!existsSync(entry)) {
    console.error(`[X] ${entry} 가 없습니다. 먼저 npm install 을 실행하세요.`);
    return 1;
  }
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (opts.capture) return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  return r.status ?? 1;
}

/** npx wrangler … 와 같다. 종료 코드를 돌려준다. T-19: 예전 Cloudflare 테스트 서버에서 데이터를 가져올 때(scripts/import-from-cloudflare.mjs)만 쓴다. */
export const wrangler = (args) => runNode(bin('wrangler', 'bin', 'wrangler.js'), args);
export const typecheck = () => runNode(bin('typescript', 'bin', 'tsc'), ['--noEmit']);
export const unitTests = () => runNode(bin('vitest', 'vitest.mjs'), ['run']);

/** git 명령 (출력을 받는다). git 이 없으면 null. */
export function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

export function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// 파이프 입력(시험용)은 한 readline 으로 줄을 모아 차례로 나눠 준다 (부를 때마다 새로 만들면 앞에서 읽어 둔 줄을 잃는다).
let piped = null;
function nextPipedLine() {
  if (!piped) {
    piped = { lines: [], waiting: [], closed: false };
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (l) => { const w = piped.waiting.shift(); if (w) w(l); else piped.lines.push(l); });
    rl.on('close', () => { piped.closed = true; for (const w of piped.waiting.splice(0)) w(''); });
  }
  if (piped.lines.length) return Promise.resolve(piped.lines.shift());
  if (piped.closed) return Promise.resolve('');
  return new Promise((resolve) => piped.waiting.push(resolve));
}

/**
 * 비밀문구 입력. 터미널이면 글자를 화면에 보이지 않는다(별표도 없음). 파이프로 들어오면(시험용) 한 줄을 읽는다.
 * 입력한 값은 어디에도 저장하거나 출력하지 않는다.
 */
export function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stdout.write(question);
    return nextPipedLine().then((l) => { process.stdout.write('\n'); return l; });
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled')); // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') { value = [...value].slice(0, -1).join(''); continue; } // 지우기
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export const fail = (msg) => {
  console.error(`\n[X] ${msg}\n`);
  process.exit(1);
};
