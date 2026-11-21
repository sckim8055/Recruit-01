// 배포 전 점검 (T-13).  npm run predeploy:test  /  npm run predeploy:prod
// (npm run deploy:test · deploy:prod 를 실행하면 npm 이 이것을 먼저 자동으로 실행한다 — 실패하면 배포하지 않는다.)
//
// test:       형식 검사(typecheck) + 테스트 + wrangler.jsonc 테스트 구역의 REPLACE_WITH_… 값
// production: 위 + 운영 구역의 REPLACE_WITH_… 값 · 신고번호 · 주소 일치 · 약관·방침의 【확인 필요】 · git(main, 저장하지 않은 변경 없음)
// 통과하면 .wrangler/predeploy-<환경>.json 에 표시를 남겨 deploy.mjs 가 같은 점검을 두 번 하지 않게 한다 (15분, 같은 커밋·같은 변경 상태일 때만).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, git, readConfig, typecheck, unitTests } from './lib/cli.mjs';
import { configIssues, countLegalMarkers, envArg, gitIssues } from './lib/deploy-checks.mjs';

export const STAMP_TTL_MS = 15 * 60 * 1000;
const stampPath = (env) => join(ROOT, '.wrangler', `predeploy-${env}.json`);

/** 지금 코드 상태의 지문: 커밋 + 변경 목록. git 이 없으면 null. */
export function treeFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  if (head === null || status === null) return null;
  return createHash('sha256').update(head).update('\n').update(status).digest('hex');
}

export function stampIsFresh(env) {
  try {
    const s = JSON.parse(readFileSync(stampPath(env), 'utf8'));
    const fp = treeFingerprint();
    return !!fp && s.fp === fp && Date.now() - s.at < STAMP_TTL_MS;
  } catch {
    return false;
  }
}

function legalSources() {
  const dir = join(ROOT, 'src', 'legal');
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [`src/legal/${f}`, readFileSync(join(dir, f), 'utf8')]));
}

/** 점검을 모두 실행하고 { ok, errors, warnings } 를 돌려준다. 결과는 화면에 쓴다. */
export function runPredeploy(env) {
  const errors = [];
  const warnings = [];
  const step = (s) => console.log(`\n== ${s}`);

  step('설정 파일 (wrangler.jsonc)');
  let config = null;
  try {
    config = readConfig();
  } catch (e) {
    errors.push(`wrangler.jsonc 를 읽을 수 없습니다 (쉼표·따옴표가 빠졌는지 확인): ${e instanceof Error ? e.message : e}`);
  }
  if (config) {
    const r = configIssues(config, env);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  if (env === 'production') {
    step('약관·개인정보처리방침의 【확인 필요】 표시');
    const m = countLegalMarkers(legalSources());
    if (m.total) {
      errors.push(`약관·방침에 채우지 않은 표시가 ${m.total}곳 남아 있습니다 (${Object.entries(m.byFile).map(([f, n]) => `${f} ${n}곳`).join(', ')}). ` +
        '모두 채우고 전문가 검토를 받은 뒤 test/account.test.ts 마지막 테스트를 toBe(0) 으로 바꿉니다 (README "이용약관·개인정보처리방침").');
    }
    step('git 상태 (main, 저장하지 않은 변경 없음)');
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = git(['status', '--porcelain']);
    if (branch === null || status === null) errors.push('git 을 실행할 수 없습니다 (Git 이 설치되어 있고 이 폴더가 저장소인지 확인).');
    else errors.push(...gitIssues(branch, status));
  }

  step('형식 검사 (npm run typecheck)');
  if (typecheck() !== 0) errors.push('형식 검사(typecheck)가 실패했습니다. 위의 오류를 개발자에게 보내세요.');
  step('테스트 (npm test)');
  if (unitTests() !== 0) errors.push('테스트가 실패했습니다. 위의 오류를 개발자에게 보내세요.');

  console.log('');
  for (const w of warnings) console.log(`[!] ${w}`);
  for (const e of errors) console.error(`[X] ${e}`);
  const ok = errors.length === 0;
  if (ok) {
    const fp = treeFingerprint();
    if (fp) {
      mkdirSync(join(ROOT, '.wrangler'), { recursive: true });
      writeFileSync(stampPath(env), JSON.stringify({ fp, at: Date.now() }));
    }
    console.log(`\n[OK] ${env === 'production' ? '운영' : '테스트'} 서버 배포 전 점검을 모두 통과했습니다.`);
  } else {
    console.error(`\n배포 전 점검 실패: 위의 [X] ${errors.length}개를 고친 뒤 다시 실행하세요. (docs/DEPLOY.md)`);
  }
  return { ok, errors, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = envArg(process.argv[2]);
  if (!env) {
    console.error('사용법: node scripts/predeploy.mjs test | production');
    process.exit(2);
  }
  process.exit(runPredeploy(env).ok ? 0 : 1);
}
