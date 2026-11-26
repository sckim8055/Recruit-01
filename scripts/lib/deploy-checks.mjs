// 배포 전 점검의 순수 함수들 (T-13). scripts/predeploy.mjs · deploy.mjs · db-migrate.mjs · backup.mjs 가 쓰고, test/deploy-checks.test.ts 가 확인한다.
// 새 npm 패키지 없이 Node 만으로 돈다. 파일·명령 실행은 하지 않는다 (받은 글만 본다).

export const PLACEHOLDER = 'REPLACE_WITH_';
export const ENVS = /** @type {const} */ (['test', 'production']);

/** wrangler.jsonc 글 → 객체. 주석(// … , /* … *\/)과 끝의 쉼표를 지운 뒤 JSON.parse. 문자열 안의 // 는 그대로 둔다. */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  // 끝의 쉼표: 문자열 밖에서 , 다음에 공백만 있고 } 또는 ] 가 오면 지운다.
  out = removeTrailingCommas(out);
  return JSON.parse(out);
}

function removeTrailingCommas(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += s[i + 1] ?? ''; i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** 환경의 설정 구역: test = 최상위(env 제외), production = env.production (없으면 null). */
export function sectionOf(config, env) {
  if (env === 'test') {
    const { env: _e, ...top } = config;
    return top;
  }
  return config?.env?.[env] ?? null;
}

/** 객체 안에서 REPLACE_WITH_ 가 들어 있는 값의 경로 목록 (예: "vars.APP_ORIGIN", "d1_databases[0].database_id"). */
export function placeholderPaths(obj, prefix = '') {
  if (typeof obj === 'string') return obj.includes(PLACEHOLDER) ? [prefix || '(값)'] : [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => placeholderPaths(v, `${prefix}[${i}]`));
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, v]) => placeholderPaths(v, prefix ? `${prefix}.${k}` : k));
  return [];
}

/** 그 환경의 사이트 도메인 (routes 의 첫 pattern). */
export function domainOf(section) {
  const r = section?.routes?.[0];
  return typeof r === 'string' ? r : typeof r?.pattern === 'string' ? r.pattern : null;
}

/** 그 환경의 D1 데이터베이스 이름 (binding DB). */
export function dbNameOf(section) {
  const d = (section?.d1_databases ?? []).find((x) => x?.binding === 'DB');
  return d?.database_name ?? null;
}

const FLAG_KEYS = ['FLAG_PRODUCTION_JOBS', 'FLAG_HEADHUNTER_POSTING', 'FLAG_RESUME_ZH_SUMMARY', 'FLAG_PAID_LABEL'];

/**
 * 설정 점검 → { errors: string[], warnings: string[] } (한국어 문장). env = 'test' | 'production'.
 * test: 자리표시자만. production: 자리표시자 · APP_ENV · 신고번호 · 주소와 도메인 일치 · workers_dev · 플래그(경고).
 */
export function configIssues(config, env) {
  const errors = [];
  const warnings = [];
  const sec = sectionOf(config, env);
  if (!sec) return { errors: [`wrangler.jsonc 에 ${env} 설정 구역이 없습니다.`], warnings };
  const ph = placeholderPaths(sec);
  if (ph.length) errors.push(`wrangler.jsonc 의 ${env === 'test' ? '테스트(맨 위)' : '운영(env.production)'} 구역에 아직 바꾸지 않은 REPLACE_WITH_… 값이 ${ph.length}곳 있습니다: ${ph.join(', ')}`);
  const vars = sec.vars ?? {};
  if (env === 'production') {
    if (vars.APP_ENV !== 'production') errors.push('운영 구역의 vars.APP_ENV 가 "production" 이 아닙니다.');
    if (!String(vars.REGISTRATION_NO ?? '').trim()) errors.push('운영 구역의 vars.REGISTRATION_NO(직업정보제공사업 신고번호)가 비어 있습니다. 신고를 마친 뒤 번호를 적으세요.');
    const domain = domainOf(sec);
    if (!domain) errors.push('운영 구역에 routes(사이트 주소)가 없습니다.');
    else if (!domain.includes(PLACEHOLDER) && vars.APP_ORIGIN !== `https://${domain}`) {
      errors.push(`운영 구역의 APP_ORIGIN("${vars.APP_ORIGIN}")이 routes 의 주소("https://${domain}")와 다릅니다.`);
    }
    if (sec.workers_dev !== false) errors.push('운영 구역의 workers_dev 가 false 가 아닙니다 (workers.dev 주소가 열립니다).');
    const on = FLAG_KEYS.filter((k) => vars[k] === 'on');
    if (on.length) warnings.push(`기능 플래그가 켜져 있습니다: ${on.join(', ')} — 켜기 전 조건(docs/ARCHITECTURE.md 5장)을 확인했는지 보세요.`);
    if (vars.DEMO_LOGIN !== undefined && vars.DEMO_LOGIN !== 'off') errors.push('운영 구역의 vars.DEMO_LOGIN(시연 계정 로그인)이 "off" 가 아닙니다. 운영 서버에는 시연 계정을 두지 않습니다 — "off" 로 바꾸세요.');
    if (vars.MAINTENANCE === 'on') warnings.push('MAINTENANCE 가 "on" 입니다 — 배포하면 관리자 말고는 점검 안내를 봅니다.');
  }
  return { errors, warnings };
}

/** TypeScript 소스에서 주석(// …, /* … *\/)을 뺀 글 (문자열 안의 // 는 남긴다 — 예: 'https://…'). */
export function stripTsComments(src) {
  let out = '';
  let i = 0;
  let q = null; // 지금 안에 있는 따옴표: ' " `
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (q) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export const LEGAL_MARKERS = ['【확인 필요', '【待确认'];

/** 법률 문서 소스(파일 이름 → 글)에서 주석을 뺀 뒤 남은 표시 수. { total, byFile: { 이름: 개수 } } */
export function countLegalMarkers(sources) {
  const byFile = {};
  let total = 0;
  for (const [name, src] of Object.entries(sources)) {
    const body = stripTsComments(src);
    const n = LEGAL_MARKERS.reduce((a, m) => a + (body.split(m).length - 1), 0);
    if (n) byFile[name] = n;
    total += n;
  }
  return { total, byFile };
}

/** git 상태 점검. branch = `git rev-parse --abbrev-ref HEAD` 출력, porcelain = `git status --porcelain` 출력. */
export function gitIssues(branch, porcelain) {
  const errors = [];
  const b = String(branch ?? '').trim();
  if (b !== 'main') errors.push(`지금 브랜치가 main 이 아닙니다 ("${b || '알 수 없음'}"). 운영 서버에는 main 만 올립니다: git checkout main 후 git pull.`);
  const dirty = String(porcelain ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (dirty.length) errors.push(`저장(커밋)하지 않은 변경이 ${dirty.length}개 있습니다. 올라갈 코드가 저장소와 같아야 합니다 (git status 로 확인).`);
  return errors;
}

/** 운영 배포 확인: 입력한 도메인이 설정의 도메인과 같은가 (앞뒤 공백·대소문자·https:// 무시). */
export function domainConfirmed(typed, domain) {
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return !!domain && norm(typed) === norm(domain);
}

/** 백업 파일 이름: backups/<env>-<yyyymmdd-hhmm>.sql.enc (PC 의 현지 시각). */
export function backupFileName(env, d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${env}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.sql.enc`;
}

/** 'test' | 'production' | 'prod' → 정규 이름. 모르면 null. */
export function envArg(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'test') return 'test';
  if (s === 'production' || s === 'prod') return 'production';
  return null;
}

/** wrangler 에 붙일 환경 인자: 테스트는 최상위라 없음. */
export const envFlags = (env) => (env === 'production' ? ['--env', 'production'] : []);
