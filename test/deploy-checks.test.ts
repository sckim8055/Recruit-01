// 배포 전 점검의 순수 함수 (T-13, scripts/lib/deploy-checks.mjs) — 실제 wrangler.jsonc 와 src/legal/ 도 읽어 본다.
import { describe, expect, it } from 'vitest';
import {
  backupFileName, configIssues, countLegalMarkers, dbNameOf, domainConfirmed, domainOf, envArg, envFlags, gitIssues, parseJsonc,
  placeholderPaths, sectionOf, stripTsComments,
} from '../scripts/lib/deploy-checks.mjs';
import { legalMarkerCounts } from '../src/lib/config-check';

interface Fs { readFileSync(p: string, enc: 'utf8'): string; readdirSync(p: string): string[] }
const fsMod = 'node:fs'; // 테스트 설정(tsconfig types)에 node 타입이 없어 동적 import
const fs = async () => (await import(fsMod)) as Fs;

const prodOk = () => ({
  name: 'recruit-test', vars: { APP_ENV: 'test' }, routes: [{ pattern: 'recruit.example.test', custom_domain: true }],
  d1_databases: [{ binding: 'DB', database_name: 'recruit-test', database_id: 'aaaa' }],
  env: {
    production: {
      name: 'recruit', workers_dev: false, routes: [{ pattern: 'jobs.example.test', custom_domain: true }],
      d1_databases: [{ binding: 'DB', database_name: 'recruit-prod', database_id: 'bbbb' }],
      vars: { APP_ENV: 'production', APP_ORIGIN: 'https://jobs.example.test', REGISTRATION_NO: '제2026-1호', FLAG_PAID_LABEL: 'off', MAINTENANCE: 'off' },
    },
  },
});

describe('parseJsonc', () => {
  it('주석·끝 쉼표를 지우고 문자열 안의 // 와 /* 는 그대로', () => {
    const o = parseJsonc(`{
      // 줄 주석
      "a": "https://x.test/p", /* 막는 주석 */ "b": "/* 아님 */",
      "c": [1, 2, ], "d": { "e": "say \\"hi\\" // no", },
    }`);
    expect(o).toEqual({ a: 'https://x.test/p', b: '/* 아님 */', c: [1, 2], d: { e: 'say "hi" // no' } });
  });
});

describe('설정 점검 (wrangler.jsonc)', () => {
  it('자리표시자 경로를 모두 찾는다', () => {
    expect(placeholderPaths({ a: 'REPLACE_WITH_X', b: [{ c: 'ok' }, { d: 'x REPLACE_WITH_Y' }], e: 1 })).toEqual(['a', 'b[1].d']);
  });

  it('정상인 운영 구역은 통과, 테스트 구역은 env 를 빼고 본다', () => {
    expect(configIssues(prodOk(), 'production')).toEqual({ errors: [], warnings: [] });
    expect(sectionOf(prodOk(), 'test').env).toBeUndefined();
    expect(configIssues(prodOk(), 'test').errors).toEqual([]);
    expect(domainOf(sectionOf(prodOk(), 'production'))).toBe('jobs.example.test');
    expect(dbNameOf(sectionOf(prodOk(), 'production'))).toBe('recruit-prod');
  });

  it('운영: 자리표시자 · 신고번호 없음 · APP_ENV · 주소 불일치 · workers_dev · 구역 없음', () => {
    const c = prodOk();
    c.env.production.d1_databases[0]!.database_id = 'REPLACE_WITH_PROD_D1_ID';
    c.env.production.vars.REGISTRATION_NO = '';
    c.env.production.vars.APP_ENV = 'test';
    c.env.production.vars.APP_ORIGIN = 'https://other.example.test';
    (c.env.production as { workers_dev?: boolean }).workers_dev = undefined;
    const e = configIssues(c, 'production').errors.join('\n');
    for (const s of ['REPLACE_WITH_', 'd1_databases[0].database_id', 'REGISTRATION_NO', 'APP_ENV', 'APP_ORIGIN', 'workers_dev']) expect(e).toContain(s);
    expect(configIssues({ name: 'x' }, 'production').errors[0]).toContain('구역이 없습니다');
  });

  it('운영: 켜진 플래그·점검 모드는 경고만', () => {
    const c = prodOk();
    c.env.production.vars.FLAG_PAID_LABEL = 'on';
    c.env.production.vars.MAINTENANCE = 'on';
    const r = configIssues(c, 'production');
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toContain('FLAG_PAID_LABEL');
    expect(r.warnings.join('\n')).toContain('MAINTENANCE');
  });

  it('저장소의 wrangler.jsonc: 읽을 수 있고, 운영 구역은 자리표시자·신고번호 때문에 막히며, 플래그는 모두 off', async () => {
    const c = parseJsonc((await fs()).readFileSync('wrangler.jsonc', 'utf8'));
    expect(c.name).toBe('recruit-test');
    expect(c.vars.APP_ENV).toBe('test');
    expect(c.env.production.name).toBe('recruit');
    expect(c.env.production.vars.APP_ENV).toBe('production');
    expect(c.env.production.workers_dev).toBe(false);
    expect(c.workers_dev).toBe(false);
    // 물려지지 않는 키(vars·d1_databases·r2_buckets·ai·secrets)는 운영 구역에 직접 있다. vars 는 최상위와 같은 이름을 모두 갖는다.
    for (const k of ['vars', 'd1_databases', 'r2_buckets', 'ai', 'secrets', 'triggers', 'observability', 'routes']) expect(c.env.production[k], k).toBeDefined();
    expect(Object.keys(c.env.production.vars).sort()).toEqual(Object.keys(c.vars).sort());
    // 테스트와 운영이 DB·버킷을 공유하지 않는다
    expect(c.env.production.d1_databases[0].database_name).not.toBe(c.d1_databases[0].database_name);
    expect(c.env.production.r2_buckets[0].bucket_name).not.toBe(c.r2_buckets[0].bucket_name);
    // 기능 플래그는 모두 off (CLAUDE.md 규칙 9)
    for (const v of [c.vars, c.env.production.vars]) for (const [k, x] of Object.entries(v)) if (k.startsWith('FLAG_')) expect(x, k).toBe('off');
    // Workers AI 바인딩은 최상위(로컬 개발)에 없다 — 로그인하지 않은 PC 의 wrangler dev 가 멈추지 않게
    expect(c.ai).toBeUndefined();
    const prod = configIssues(c, 'production').errors.join('\n');
    expect(prod).toContain('REPLACE_WITH_');
    expect(prod).toContain('REGISTRATION_NO');
    expect(placeholderPaths(sectionOf(c, 'production'))).toEqual(expect.arrayContaining(['vars.APP_ORIGIN', 'routes[0].pattern', 'd1_databases[0].database_id']));
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

describe('git · 확인 입력 · 파일 이름', () => {
  it('main 이 아니거나 저장하지 않은 변경이 있으면 막는다', () => {
    expect(gitIssues('main\n', '')).toEqual([]);
    expect(gitIssues('t-13', '')[0]).toContain('main 이 아닙니다');
    expect(gitIssues('main', ' M src/index.tsx\n?? x.txt\n')[0]).toContain('2개');
    expect(gitIssues(null, null).length).toBe(1);
  });
  it('도메인 확인: 대소문자·공백·https:// 무시, 다르거나 비면 거절', () => {
    expect(domainConfirmed(' Jobs.Example.test ', 'jobs.example.test')).toBe(true);
    expect(domainConfirmed('https://jobs.example.test/', 'jobs.example.test')).toBe(true);
    expect(domainConfirmed('', 'jobs.example.test')).toBe(false);
    expect(domainConfirmed('recruit.example.test', 'jobs.example.test')).toBe(false);
    expect(domainConfirmed('x', null)).toBe(false);
  });
  it('백업 파일 이름 · 환경 인자', () => {
    expect(backupFileName('production', new Date(2026, 10, 3, 9, 5))).toBe('production-20261103-0905.sql.enc');
    expect([envArg('test'), envArg('prod'), envArg('production'), envArg('dev'), envArg(undefined)]).toEqual(['test', 'production', 'production', null, null]);
    expect(envFlags('test')).toEqual([]);
    expect(envFlags('production')).toEqual(['--env', 'production']);
  });
});
