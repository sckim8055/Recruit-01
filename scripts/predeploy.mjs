// 운영 서버 올리기 전 점검 (T-13, T-19).  npm run predeploy:prod  [-- --env-file <운영 .env 경로>]  (기본: 이 폴더의 .env)
// 나중에 운영 서버(production)를 따로 둘 때 쓴다. 지금의 recruit.kimbbob.xyz 한 대(APP_ENV=test)에는 쓰지 않는다.
//
// 점검: 운영 .env (APP_ENV=production · 필수 값 · REPLACE_WITH_… · 신고번호 · https 주소 · 시연 로그인 off · 플래그 경고)
//       · 약관·방침의 【확인 필요】 · git(main, 저장하지 않은 변경 없음) · 형식 검사 · 테스트
// .env 의 값(비밀값)은 화면에 쓰지 않는다 — 이름만.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { ROOT, git, typecheck, unitTests } from './lib/cli.mjs';
import { configIssues, countLegalMarkers, envArg, gitIssues } from './lib/deploy-checks.mjs';

function legalSources() {
  const dir = join(ROOT, 'src', 'legal');
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [`src/legal/${f}`, readFileSync(join(dir, f), 'utf8')]));
}

/** 점검을 모두 실행하고 { ok, errors, warnings } 를 돌려준다. 결과는 화면에 쓴다. */
export function runPredeploy(envFile) {
  const errors = [];
  const warnings = [];
  const step = (s) => console.log(`\n== ${s}`);

  step(`운영 설정 (${envFile})`);
  if (!existsSync(envFile)) errors.push(`${envFile} 가 없습니다. 운영 서버의 .env 경로를 --env-file 로 주세요.`);
  else {
    const r = configIssues(parseEnv(readFileSync(envFile, 'utf8')));
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

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

  step('형식 검사 (npm run typecheck)');
  if (typecheck() !== 0) errors.push('형식 검사(typecheck)가 실패했습니다. 위의 오류를 개발자에게 보내세요.');
  step('테스트 (npm test)');
  if (unitTests() !== 0) errors.push('테스트가 실패했습니다. 위의 오류를 개발자에게 보내세요.');

  console.log('');
  for (const w of warnings) console.log(`[!] ${w}`);
  for (const e of errors) console.error(`[X] ${e}`);
  const ok = errors.length === 0;
  if (ok) console.log('\n[OK] 운영 서버 점검을 모두 통과했습니다.');
  else console.error(`\n점검 실패: 위의 [X] ${errors.length}개를 고친 뒤 다시 실행하세요. (docs/DEPLOY.md 11장)`);
  return { ok, errors, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!envArg(process.argv[2])) {
    console.error('사용법: node scripts/predeploy.mjs production [--env-file <운영 .env>]');
    process.exit(2);
  }
  const i = process.argv.indexOf('--env-file');
  process.exit(runPredeploy(i > 0 ? process.argv[i + 1] : join(ROOT, '.env')).ok ? 0 : 1);
}
