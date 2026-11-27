// 운영 서버 올리기 전 점검의 순수 함수들 (T-13, T-19). scripts/predeploy.mjs 가 쓰고 test/deploy-checks.test.ts 가 확인한다.
// T-19: 설정은 wrangler.jsonc 가 아니라 서버 PC 의 .env (운영 서버용 .env 파일) 다. 파일·명령 실행은 하지 않는다 (받은 글만 본다).

export const PLACEHOLDER = 'REPLACE_WITH_';
export const ENVS = /** @type {const} */ (['production']);

const FLAG_KEYS = ['FLAG_PRODUCTION_JOBS', 'FLAG_HEADHUNTER_POSTING', 'FLAG_RESUME_ZH_SUMMARY', 'FLAG_PAID_LABEL'];
/** 운영 .env 에 반드시 있어야 하는 이름 (값은 보지 않는다 — 비었는지만). */
export const REQUIRED_KEYS = ['APP_ENV', 'APP_ORIGIN', 'MAIL_FROM', 'OPERATOR_DOMAINS', 'DATABASE_URL', 'ENC_KEY', 'SESSION_PEPPER', 'RESEND_API_KEY', 'DATA_DIR'];

/** 값에 REPLACE_WITH_ 가 들어 있는 변수 이름 목록. */
export function placeholderKeys(vars) {
  return Object.entries(vars ?? {}).filter(([, v]) => typeof v === 'string' && v.includes(PLACEHOLDER)).map(([k]) => k).sort();
}

/**
 * 운영 .env 점검 → { errors: string[], warnings: string[] } (한국어 문장). vars = .env 를 읽은 객체 (util.parseEnv).
 * 비밀값의 값은 문장에 넣지 않는다 (이름만).
 */
export function configIssues(vars) {
  const errors = [];
  const warnings = [];
  const v = vars ?? {};
  const ph = placeholderKeys(v);
  if (ph.length) errors.push(`.env 에 아직 바꾸지 않은 REPLACE_WITH_… 값이 ${ph.length}곳 있습니다: ${ph.join(', ')}`);
  const missing = REQUIRED_KEYS.filter((k) => !String(v[k] ?? '').trim());
  if (missing.length) errors.push(`.env 에 비어 있는 필수 값이 있습니다: ${missing.join(', ')}`);
  if (v.APP_ENV !== 'production') errors.push('.env 의 APP_ENV 가 "production" 이 아닙니다.');
  if (!String(v.REGISTRATION_NO ?? '').trim()) errors.push('.env 의 REGISTRATION_NO(직업정보제공사업 신고번호)가 비어 있습니다. 신고를 마친 뒤 번호를 적으세요.');
  const origin = String(v.APP_ORIGIN ?? '');
  if (origin && !origin.includes(PLACEHOLDER) && !/^https:\/\/[^/\s]+$/.test(origin)) errors.push(`.env 의 APP_ORIGIN 이 https:// 로 시작하는 주소(끝에 / 없이)가 아닙니다.`);
  if (v.DEMO_LOGIN !== undefined && v.DEMO_LOGIN !== 'off') errors.push('.env 의 DEMO_LOGIN(시연 계정 로그인)이 "off" 가 아닙니다. 운영 서버에는 시연 계정을 두지 않습니다 — "off" 로 바꾸세요.');
  if (String(v.SESSION_PEPPER ?? '') === 'dev-pepper-local-only-1234') errors.push('.env 의 SESSION_PEPPER 가 예전 로컬 개발용 예시 값입니다. 새 값을 만들어 넣으세요.');
  const on = FLAG_KEYS.filter((k) => v[k] === 'on');
  if (on.length) warnings.push(`기능 플래그가 켜져 있습니다: ${on.join(', ')} — 켜기 전 조건(docs/ARCHITECTURE.md 5장)을 확인했는지 보세요.`);
  if (v.MAINTENANCE === 'on') warnings.push('MAINTENANCE 가 "on" 입니다 — 서버를 켜면 관리자 말고는 점검 안내를 봅니다.');
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

/** 'production' | 'prod' → 정규 이름. 모르면 null. (T-19: 테스트 서버는 이 PC 하나뿐이라 점검 대상이 아니다.) */
export function envArg(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'production' || s === 'prod') return 'production';
  return null;
}
