// 운영 서버 점검의 순수 함수 (T-13, T-19: scripts/lib/deploy-checks.mjs) — 저장소의 .env.example 과 src/legal/ 도 읽어 본다.
// T-19: 설정 파일이 wrangler.jsonc 에서 .env 로 바뀌어 wrangler 구역(test·production) 점검 시험을 .env 점검 시험으로 바꿨다.
import { describe, expect, it } from 'vitest';
import { configIssues, countLegalMarkers, envArg, gitIssues, placeholderKeys, REQUIRED_KEYS, stripTsComments } from '../scripts/lib/deploy-checks.mjs';
import { backupFileName } from '../scripts/lib/backup-pack.mjs';
import { legalMarkerCounts } from '../src/lib/config-check';

interface Fs { readFileSync(p: string, enc: 'utf8'): string; readdirSync(p: string): string[] }
const fsMod = 'node:fs';
const fs = async () => (await import(fsMod)) as Fs;

const prodOk = (): Record<string, string> => ({
  APP_ENV: 'production', APP_ORIGIN: 'https://jobs.example.test', MAIL_FROM: 'Recruit <no-reply@jobs.example.test>', OPERATOR_DOMAINS: 'jobs.example.test',
  DATABASE_URL: 'postgres://recruit:fake@localhost:5433/recruit', ENC_KEY: 'fake-key', SESSION_PEPPER: 'fake-pepper-0123456789', RESEND_API_KEY: 'fake',
  DATA_DIR: 'F:\\data', REGISTRATION_NO: '제2026-1호', FLAG_PAID_LABEL: 'off', MAINTENANCE: 'off', DEMO_LOGIN: 'off',
});

describe('운영 .env 점검', () => {
  it('자리표시자가 든 변수 이름을 모두 찾는다', () => {
    expect(placeholderKeys({ A: 'REPLACE_WITH_X', B: 'ok', C: 'x REPLACE_WITH_Y' })).toEqual(['A', 'C']);
  });

  it('정상인 운영 설정은 통과', () => expect(configIssues(prodOk())).toEqual({ errors: [], warnings: [] }));

  it('운영: 자리표시자 · 필수 값 없음 · 신고번호 없음 · APP_ENV · https 아님 · 시연 로그인 · 예시 pepper', () => {
    const c = { ...prodOk(), APP_ORIGIN: 'https://REPLACE_WITH_PRODUCTION_DOMAIN', REGISTRATION_NO: '', APP_ENV: 'test', RESEND_API_KEY: '', DEMO_LOGIN: 'on' };
    const e = configIssues(c).errors.join('\n');
    for (const s of ['REPLACE_WITH_', 'APP_ORIGIN', 'RESEND_API_KEY', 'REGISTRATION_NO', 'APP_ENV', 'DEMO_LOGIN']) expect(e).toContain(s);
    expect(configIssues({ ...prodOk(), APP_ORIGIN: 'http://jobs.example.test' }).errors.join()).toContain('https://');
    expect(configIssues({ ...prodOk(), SESSION_PEPPER: 'dev-pepper-local-only-1234' }).errors.join()).toContain('SESSION_PEPPER');
    expect(configIssues({}).errors.join()).toContain(REQUIRED_KEYS.join(', '));
    // 비밀값의 값은 문장에 넣지 않는다
    expect(JSON.stringify(configIssues({ ...prodOk(), ENC_KEY: 'REPLACE_WITH_secret-value-1' }))).not.toContain('secret-value-1');
  });

  it('운영: 켜진 플래그·점검 모드는 경고만', () => {
    const r = configIssues({ ...prodOk(), FLAG_PAID_LABEL: 'on', MAINTENANCE: 'on' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toContain('FLAG_PAID_LABEL');
    expect(r.warnings.join('\n')).toContain('MAINTENANCE');
  });

  it('저장소의 .env.example: 모든 키가 있고 기능 플래그는 off, 비밀값은 비어 있다', async () => {
    const { parseEnv } = await import('node:util');
    const ex = parseEnv((await fs()).readFileSync('.env.example', 'utf8'));
    for (const k of [...REQUIRED_KEYS, 'PORT', 'REGISTRATION_NO', 'MAINTENANCE', 'DEMO_LOGIN', 'BACKUP_DIR', 'PG_BIN']) expect(k in ex, k).toBe(true);
    for (const [k, v] of Object.entries(ex)) if (k.startsWith('FLAG_')) expect(v, k).toBe('off');
    for (const k of ['ENC_KEY', 'SESSION_PEPPER', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'BACKUP_PASSPHRASE']) expect(ex[k], k).toBe('');
    expect(ex.DATABASE_URL).toContain('CHANGE_ME');
  });
});

describe('약관·방침 표시 세기 (주석 제외)', () => {
  it('주석 안의 표시는 세지 않고, 문자열 안의 // 는 남긴다', () => {
    const src = `// 【확인 필요】 표시가 남아 있는 동안은 …\n/* 【待确认】 */\nconst a = 'https://x.test 【확인 필요: 이름】';\nconst b = \`【待确认：x】\`;`;
    expect(stripTsComments(src)).toContain("'https://x.test 【확인 필요: 이름】'");
    expect(countLegalMarkers({ 'a.ts': src })).toEqual({ total: 2, byFile: { 'a.ts': 2 } });
    expect(countLegalMarkers({ 'b.ts': '// 【확인 필요】 주석뿐' })).toEqual({ total: 0, byFile: {} });
  });

  it('지금 src/legal/ 에는 표시가 남아 있다 (화면 점검과 같이 0 보다 큼)', async () => {
    const f = await fs();
    const sources = Object.fromEntries(f.readdirSync('src/legal').filter((n) => n.endsWith('.ts')).map((n) => [n, f.readFileSync(`src/legal/${n}`, 'utf8')]));
    const scan = countLegalMarkers(sources);
    const shown = legalMarkerCounts();
    expect(scan.total).toBeGreaterThan(0);
    expect(shown.ko + shown.zh).toBeGreaterThan(0);
    // types.ts 의 설명 주석 "【확인 필요】 표시가 남아 있는 동안은 …" 은 세지 않는다 → 운영자가 모두 채우면 0 이 된다
    expect(stripTsComments(sources['types.ts']!)).not.toContain('표시가 남아 있는 동안은');
  });
});

describe('git · 인자 · 백업 파일 이름', () => {
  it('main 이 아니거나 저장하지 않은 변경이 있으면 막는다', () => {
    expect(gitIssues('main\n', '')).toEqual([]);
    expect(gitIssues('t-13', '')[0]).toContain('main 이 아닙니다');
    expect(gitIssues('main', ' M src/index.tsx\n?? x.txt\n')[0]).toContain('2개');
    expect(gitIssues(null, null).length).toBe(1);
  });
  it('백업 파일 이름 · 환경 인자 (T-19: recruit-<날짜>.enc, 운영만)', () => {
    expect(backupFileName(new Date(2026, 10, 3, 9, 5))).toBe('recruit-20261103-0905.enc');
    expect([envArg('test'), envArg('prod'), envArg('production'), envArg('dev'), envArg(undefined)]).toEqual([null, 'production', 'production', null, null]);
  });
});
