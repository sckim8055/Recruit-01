// 직무·업계·근무지 선택 항목 (T-06e): 순수 함수(lib/options), validateJob·공개 필터와의 연결, 0007 기본 행, db/options 의 SQL, 관리자 화면.
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { countOptionUsage, insertOption, listOptions, setOptionActive, updateOption } from '../src/db/options';
import { EMPTY_JOB_INPUT, parseKstDate, validateJob, type JobInput } from '../src/lib/jobs';
import {
  activeCodes, buildOptionSet, labelOf, nextSort, readOptionInput, restoreProblem, retireProblem, selectableAll, selectableCodes,
  validateOptionAdd, validateOptionEdit, type OptionInput, type OptionRow,
} from '../src/lib/options';
import { canonicalJobsHref, FILTER_KEYS, filterChoices, parseJobFilter } from '../src/lib/public-jobs';
import { agreeRequired } from './consent-fixture';
import { optionRows, SEED_OPTIONS } from './option-seed';

const row = (p: Partial<OptionRow> & Pick<OptionRow, 'kind' | 'code'>): OptionRow =>
  ({ label_ko: `${p.code}-ko`, label_zh: `${p.code}-zh`, sort: 10, active: 1, ...p });

// 업계: trade 는 사용 종료, gaming 도 사용 종료, 나머지는 사용 중
const SAMPLE = buildOptionSet([
  row({ kind: 'industry', code: 'trade', label_ko: '무역', label_zh: '贸易', sort: 30, active: 0 }),
  row({ kind: 'industry', code: 'battery', label_ko: '배터리', label_zh: '电池', sort: 20 }),
  row({ kind: 'industry', code: 'auto', sort: 20 }),
  row({ kind: 'industry', code: 'gaming', sort: 5, active: 0 }),
  row({ kind: 'role_category', code: 'sales', label_ko: '영업', label_zh: '销售' }),
  row({ kind: 'location', code: 'seoul' }),
  row({ kind: 'location', code: 'busan', sort: 20 }),
  { kind: 'nope' as never, code: 'x', label_ko: 'x', label_zh: 'x', sort: 1, active: 1 },
]);

describe('buildOptionSet', () => {
  it('종류별로 sort 순서, 같으면 code 순서. 모르는 종류는 버린다', () => {
    expect(SAMPLE.list.industry.map((r) => r.code)).toEqual(['gaming', 'auto', 'battery', 'trade']);
    expect(SAMPLE.list.location.map((r) => r.code)).toEqual(['seoul', 'busan']);
    expect(Object.keys(SAMPLE.list)).toEqual(['role_category', 'industry', 'location']);
  });
  it('active 는 0/1 로 맞춘다 (드라이버가 다른 값을 줘도)', () => {
    const s = buildOptionSet([row({ kind: 'location', code: 'a', active: true as never }), row({ kind: 'location', code: 'b', active: 0 })]);
    expect(s.list.location.map((r) => r.active)).toEqual([1, 0]);
  });
});

describe('labelOf', () => {
  it('사용 중인 항목: 언어별 이름', () => {
    expect(labelOf(SAMPLE, 'industry', 'battery', 'ko')).toBe('배터리');
    expect(labelOf(SAMPLE, 'industry', 'battery', 'zh')).toBe('电池');
  });
  it('사용 종료된 항목도 이름을 돌려준다 (기존 공고는 그대로 보인다)', () => {
    expect(labelOf(SAMPLE, 'industry', 'trade', 'ko')).toBe('무역');
    expect(labelOf(SAMPLE, 'industry', 'trade', 'zh')).toBe('贸易');
  });
  it('표에 없는 code 는 code 그대로, 값이 없으면 빈 문자열', () => {
    expect(labelOf(SAMPLE, 'industry', 'semiconductor', 'ko')).toBe('semiconductor');
    expect(labelOf(SAMPLE, 'industry', null, 'ko')).toBe('');
    expect(labelOf(SAMPLE, 'industry', '', 'zh')).toBe('');
  });
  it('종류가 다르면 다른 항목 (같은 code 라도)', () => {
    expect(labelOf(SAMPLE, 'location', 'trade', 'ko')).toBe('trade');
  });
});

describe('activeCodes · selectableCodes', () => {
  it('사용 중인 것만 순서대로', () => expect(activeCodes(SAMPLE, 'industry')).toEqual(['auto', 'battery']));
  it('새 공고: 사용 중인 것만', () => {
    expect(selectableCodes(SAMPLE, 'industry', null)).toEqual(['auto', 'battery']);
    expect(selectableAll(SAMPLE).industry).toEqual(['auto', 'battery']);
  });
  it('편집: 저장된 값이 사용 종료면 맨 뒤에 붙는다 (다른 사용 종료 항목은 없음)', () => {
    expect(selectableCodes(SAMPLE, 'industry', 'trade')).toEqual(['auto', 'battery', 'trade']);
    expect(selectableAll(SAMPLE, { industry: 'trade', location: null }).industry).toEqual(['auto', 'battery', 'trade']);
  });
  it('편집: 저장된 값이 사용 중이면 그대로, 표에 없는 값이어도 붙는다', () => {
    expect(selectableCodes(SAMPLE, 'industry', 'battery')).toEqual(['auto', 'battery']);
    expect(selectableCodes(SAMPLE, 'industry', 'ghost')).toEqual(['auto', 'battery', 'ghost']);
  });
  it('결과를 고쳐도 OptionSet 은 바뀌지 않는다', () => {
    selectableCodes(SAMPLE, 'industry', 'trade').push('x');
    expect(activeCodes(SAMPLE, 'industry')).toEqual(['auto', 'battery']);
  });
});

describe('관리자 입력 검사', () => {
  const inp = (p: Partial<OptionInput> = {}): OptionInput => ({ code: 'semiconductor', label_ko: '반도체', label_zh: '半导体', sort: '170', ...p });
  const errs = (r: { ok: boolean; errors?: { field: string; code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => `${e.field}:${e.code}`));

  it('readOptionInput: 앞뒤 공백 제거, 문자열이 아니면 빈 값', () => {
    expect(readOptionInput({ code: ' abc ', label_ko: ' 가 ', label_zh: new File([], 'x'), sort: ' 10' }))
      .toEqual({ code: 'abc', label_ko: '가', label_zh: '', sort: '10' });
  });
  it('정상 입력', () => {
    const r = validateOptionAdd(inp(), SAMPLE, 'industry');
    expect(r.ok && r.value).toEqual({ code: 'semiconductor', label_ko: '반도체', label_zh: '半导体', sort: 170 });
  });
  it('code: 소문자로 시작, 소문자·숫자·밑줄 2~30자', () => {
    for (const code of ['ab', 'a1', 'a_b', 'x'.repeat(30), 'it_software2']) expect(errs(validateOptionAdd(inp({ code }), SAMPLE, 'industry')), code).toEqual([]);
    for (const code of ['a', '1ab', '_ab', 'Semi', 'semi-con', 'semi con', '반도체', 'x'.repeat(31), "a'--", 'ab\n']) {
      expect(errs(validateOptionAdd(inp({ code }), SAMPLE, 'industry')), code).toEqual(['code:invalid']);
    }
    expect(errs(validateOptionAdd(inp({ code: '' }), SAMPLE, 'industry'))).toEqual(['code:required']);
  });
  it('code: 같은 종류 안에서 중복 금지 (사용 종료된 항목 포함). 다른 종류에는 같은 code 를 쓸 수 있다', () => {
    expect(errs(validateOptionAdd(inp({ code: 'battery' }), SAMPLE, 'industry'))).toEqual(['code:duplicate']);
    expect(errs(validateOptionAdd(inp({ code: 'trade' }), SAMPLE, 'industry'))).toEqual(['code:duplicate']);
    expect(errs(validateOptionAdd(inp({ code: 'trade' }), SAMPLE, 'location'))).toEqual([]);
  });
  it('이름: 둘 다 필수, 40자까지, 줄바꿈·제어 문자 금지, 금지 표현 금지', () => {
    expect(errs(validateOptionAdd(inp({ label_ko: '', label_zh: '' }), SAMPLE, 'industry'))).toEqual(['label_ko:required', 'label_zh:required']);
    expect(errs(validateOptionAdd(inp({ label_ko: '가'.repeat(40), label_zh: '字'.repeat(40) }), SAMPLE, 'industry'))).toEqual([]);
    expect(errs(validateOptionAdd(inp({ label_ko: '가'.repeat(41), label_zh: '字'.repeat(41) }), SAMPLE, 'industry'))).toEqual(['label_ko:too_long', 'label_zh:too_long']);
    expect(errs(validateOptionAdd(inp({ label_ko: '반도\n체', label_zh: '半导\t体' }), SAMPLE, 'industry'))).toEqual(['label_ko:invalid', 'label_zh:invalid']);
    expect(errs(validateOptionAdd(inp({ label_ko: '취업알선' }), SAMPLE, 'industry'))).toEqual(['label_ko:banned']);
  });
  it('이름은 글로 받는다 (HTML 도 그대로 저장 — 화면은 JSX 이스케이프)', () => {
    const r = validateOptionEdit(inp({ label_ko: '<b>x</b>' }));
    expect(r.ok && r.value.label_ko).toBe('<b>x</b>');
  });
  it('순서: 0~9999 정수', () => {
    expect(errs(validateOptionEdit(inp({ sort: '0' })))).toEqual([]);
    expect(errs(validateOptionEdit(inp({ sort: '9999' })))).toEqual([]);
    expect(errs(validateOptionEdit(inp({ sort: '10000' })))).toEqual(['sort:range']);
    for (const sort of ['-1', '1.5', 'abc', '1e3']) expect(errs(validateOptionEdit(inp({ sort }))), sort).toEqual(['sort:invalid']);
    expect(errs(validateOptionEdit(inp({ sort: '' })))).toEqual(['sort:required']);
  });
  it('고치기는 code 를 보지 않는다 (바꿀 수 없으므로)', () => {
    const r = validateOptionEdit(inp({ code: 'WHATEVER' }));
    expect(r.ok && Object.keys(r.value)).toEqual(['label_ko', 'label_zh', 'sort']);
  });
  it('nextSort: 가장 큰 순서 + 10, 9999 까지', () => {
    expect(nextSort(SAMPLE, 'industry')).toBe(40);
    expect(nextSort(buildOptionSet([row({ kind: 'industry', code: 'aa', sort: 9995 })]), 'industry')).toBe(9999);
    expect(nextSort(buildOptionSet([]), 'industry')).toBe(10);
  });
});

describe('사용 종료 · 다시 사용 확인', () => {
  it('마지막 사용 중 항목은 사용 종료할 수 없다', () => {
    expect(retireProblem(SAMPLE, 'role_category', 'sales')).toBe('last_active');
    const two = buildOptionSet([row({ kind: 'industry', code: 'aa' }), row({ kind: 'industry', code: 'bb' }), row({ kind: 'industry', code: 'cc', active: 0 })]);
    expect(retireProblem(two, 'industry', 'aa')).toBeNull();
  });
  it('이미 사용 종료·없는 항목', () => {
    expect(retireProblem(SAMPLE, 'industry', 'trade')).toBe('already_inactive');
    expect(retireProblem(SAMPLE, 'industry', 'ghost')).toBe('unknown');
    expect(restoreProblem(SAMPLE, 'industry', 'trade')).toBeNull();
    expect(restoreProblem(SAMPLE, 'industry', 'battery')).toBe('already_active');
    expect(restoreProblem(SAMPLE, 'industry', 'ghost')).toBe('unknown');
  });
});

describe('validateJob 과 사용 종료된 항목', () => {
  const flagsOff = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
  const base = { flags: flagsOff, operatorDomains: ['kimbbob.com'], now: parseKstDate('2026-11-21')! - 86399 };
  const form = (p: Partial<JobInput>): JobInput => ({ ...EMPTY_JOB_INPUT, title_zh: '销售经理', source_zh: '负责销售。', ...p });
  const errs = (r: ReturnType<typeof validateJob>) => (r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`));

  it('새 공고: 사용 종료된 값은 거부, 사용 중인 값은 통과', () => {
    const ctx = { ...base, options: selectableAll(SAMPLE) };
    expect(errs(validateJob(form({ industry: 'trade' }), ctx))).toEqual(['industry:invalid']);
    expect(errs(validateJob(form({ industry: 'battery' }), ctx))).toEqual([]);
  });
  it('편집: 저장된 값과 같은 사용 종료 값은 통과 (다른 칸만 고쳐도 분류가 그대로)', () => {
    const ctx = { ...base, options: selectableAll(SAMPLE, { industry: 'trade' }) };
    const r = validateJob(form({ industry: 'trade', title_zh: '新标题' }), ctx);
    expect(r.ok && r.value.industry).toBe('trade');
  });
  it('편집: 저장된 값이 아닌 다른 사용 종료 값은 거부 (위조한 POST)', () => {
    const ctx = { ...base, options: selectableAll(SAMPLE, { industry: 'trade' }) };
    expect(errs(validateJob(form({ industry: 'gaming' }), ctx))).toEqual(['industry:invalid']);
    expect(errs(validateJob(form({ industry: 'ghost' }), ctx))).toEqual(['industry:invalid']);
  });
  it('편집: 사용 종료된 값에서 사용 중인 값으로 바꾸거나 비울 수 있다', () => {
    const ctx = { ...base, options: selectableAll(SAMPLE, { industry: 'trade' }) };
    expect(errs(validateJob(form({ industry: 'auto' }), ctx))).toEqual([]);
    const r = validateJob(form({ industry: '' }), ctx);
    expect(r.ok && r.value.industry).toBeNull();
  });
  it('직무·업계·근무지는 선택 사항 (비우면 null)', () => {
    const r = validateJob(form({}), { ...base, options: selectableAll(SAMPLE) });
    expect(r.ok && [r.value.role_category, r.value.industry, r.value.location]).toEqual([null, null, null]);
  });
});

describe('공개 검색 필터와 사용 종료된 항목', () => {
  const choices = filterChoices(SAMPLE);
  it('검색 값은 사용 중인 항목만, 고정 목록은 그대로', () => {
    expect(choices.industry).toEqual(['auto', 'battery']);
    expect(choices.location).toEqual(['seoul', 'busan']);
    expect(choices.report_line).toEqual(['kr_head', 'cn_hq']);
  });
  it('사용 종료·없는 값은 모르는 값과 같이 버린다', () => {
    expect(parseJobFilter({ industry: 'trade', location: 'seoul' }, FILTER_KEYS, choices)).toEqual({ location: 'seoul' });
    expect(parseJobFilter({ industry: 'ghost' }, FILTER_KEYS, choices)).toEqual({});
    expect(parseJobFilter({ industry: 'battery' }, FILTER_KEYS, choices)).toEqual({ industry: 'battery' });
  });
  it('정규화 주소에서 빠진다', () => {
    expect(canonicalJobsHref({ industry: 'trade', page: '2' }, FILTER_KEYS, choices)).toBe('/jobs?page=2');
    expect(canonicalJobsHref({ industry: 'trade' }, ['industry'], choices)).toBe('/jobs');
  });
});

// ── SQLite 메모리 DB (Node 22 의 node:sqlite): 0007 기본 행, db/options 의 SQL

type Sqlite = {
  exec(s: string): void;
  prepare(s: string): { run(...a: unknown[]): { changes: number | bigint }; all(...a: unknown[]): Record<string, unknown>[]; get(...a: unknown[]): Record<string, unknown> | undefined };
};
let DatabaseSync: (new (p: string) => Sqlite) | null = null;
let fs: { readdirSync(p: string): string[]; readFileSync(p: string, e: 'utf8'): string } | null = null;
try {
  const sqliteMod = 'node:sqlite', fsMod = 'node:fs';
  DatabaseSync = ((await import(sqliteMod)) as { DatabaseSync: new (p: string) => Sqlite }).DatabaseSync;
  fs = (await import(fsMod)) as typeof fs;
} catch { /* node:sqlite 가 없는 Node 버전 */ }

const migrationFiles = () => fs!.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort();
function migrated(upTo = '9999'): Sqlite {
  const db = new DatabaseSync!(':memory:');
  for (const f of migrationFiles().filter((x) => x.slice(0, 4) <= upTo)) db.exec(fs!.readFileSync(`migrations/${f}`, 'utf8'));
  return db;
}
const plain = (r: Record<string, unknown>) => ({ ...r });

/** node:sqlite 를 D1 처럼 쓰는 작은 어댑터 (prepare·bind·first·all·run 만). */
function d1(db: Sqlite) {
  return {
    prepare(sql: string) {
      let b: unknown[] = [];
      const st = {
        bind: (...x: unknown[]) => { b = x; return st; },
        first: async () => { const r = db.prepare(sql).get(...b); return r ? plain(r) : null; },
        all: async () => ({ results: db.prepare(sql).all(...b).map(plain) }),
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...b).changes) } }),
      };
      return st;
    },
  } as unknown as D1Database;
}

describe.skipIf(!DatabaseSync)('0007 기본 행', () => {
  it('이 작업 전 locales 의 이름·상수 순서와 같다 (sort 10 간격, 모두 사용 중)', () => {
    const db = migrated();
    const got = db.prepare('SELECT kind, code, label_ko, label_zh, sort, active FROM job_options ORDER BY kind, sort').all().map(plain);
    const want = optionRows().sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.sort - b.sort));
    expect(got).toEqual(want);
    expect(got).toHaveLength(49);
    expect(SEED_OPTIONS.filter((r) => r[0] === 'role_category')).toHaveLength(15);
    expect(SEED_OPTIONS.filter((r) => r[0] === 'industry')).toHaveLength(16);
    expect(SEED_OPTIONS.filter((r) => r[0] === 'location')).toHaveLength(18);
  });
  it('기본 행의 code 는 관리자 화면의 code 규칙을 따른다', () => {
    for (const [, code] of SEED_OPTIONS) expect(code).toMatch(/^[a-z][a-z0-9_]{1,29}$/);
  });
  it('공고가 이미 있는 DB 에도 적용되고, 공고 값은 바뀌지 않는다', () => {
    const db = migrated('0006');
    db.exec("INSERT INTO users (id, email, role, created_at) VALUES ('u1','u1@example.test','company',0)");
    db.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜기업','kr_entity','verified',0)");
    db.exec(`INSERT INTO jobs (id, company_id, created_by, title_ko, status, role_category, industry, location, created_at, updated_at)
             VALUES ('j1','c1','u1','t','published','sales','trade','seoul',0,0), ('j2','c1','u1','t','draft',NULL,'old_code',NULL,0,0)`);
    const before = db.prepare('SELECT * FROM jobs ORDER BY id').all().map(plain);
    db.exec(fs!.readFileSync('migrations/0007_job_options.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all().map(plain)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_options').get()!.n).toBe(49);
  });
  it('종류 CHECK 제약', () => {
    const db = migrated();
    expect(() => db.exec("INSERT INTO job_options (kind, code, label_ko, label_zh, sort, created_at, updated_at) VALUES ('salary','x','x','x',1,0,0)")).toThrow();
  });
});

describe.skipIf(!DatabaseSync)('db/options (SQLite)', () => {
  const setup = () => {
    const raw = migrated();
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('adm1','a@example.test','admin',0)");
    return { raw, db: d1(raw) };
  };
  it('listOptions: 모든 종류·모든 행 한 번에', async () => {
    const { db } = setup();
    const set = buildOptionSet(await listOptions(db));
    expect(set.list.industry.map((r) => r.code)).toEqual(SEED_OPTIONS.filter((r) => r[0] === 'industry').map((r) => r[1]));
  });
  it('insertOption: 새 항목은 사용 중으로, 같은 (kind, code) 는 false 이고 기존 행은 그대로', async () => {
    const { raw, db } = setup();
    expect(await insertOption(db, { kind: 'industry', code: 'semiconductor', label_ko: '반도체', label_zh: '半导体', sort: 170, userId: 'adm1', ts: 5 })).toBe(true);
    expect(await insertOption(db, { kind: 'industry', code: 'trade', label_ko: 'X', label_zh: 'X', sort: 1, userId: 'adm1', ts: 6 })).toBe(false);
    expect(plain(raw.prepare("SELECT label_ko, active, updated_by, created_at FROM job_options WHERE kind='industry' AND code='semiconductor'").get()!))
      .toEqual({ label_ko: '반도체', active: 1, updated_by: 'adm1', created_at: 5 });
    expect(raw.prepare("SELECT label_ko FROM job_options WHERE kind='industry' AND code='trade'").get()!.label_ko).toBe('무역');
    // 다른 종류에는 같은 code 가능
    expect(await insertOption(db, { kind: 'location', code: 'trade', label_ko: 'x', label_zh: 'x', sort: 1, userId: 'adm1', ts: 6 })).toBe(true);
  });
  it('updateOption: 이름·순서만 바뀐다', async () => {
    const { raw, db } = setup();
    expect(await updateOption(db, { kind: 'industry', code: 'trade', label_ko: '무역·수출입', label_zh: '贸易与进出口', sort: 5, userId: 'adm1', ts: 7 })).toBe(true);
    expect(plain(raw.prepare("SELECT code, label_ko, label_zh, sort, active, updated_at FROM job_options WHERE kind='industry' AND code='trade'").get()!))
      .toEqual({ code: 'trade', label_ko: '무역·수출입', label_zh: '贸易与进出口', sort: 5, active: 1, updated_at: 7 });
    expect(await updateOption(db, { kind: 'industry', code: 'ghost', label_ko: 'x', label_zh: 'x', sort: 1, userId: 'adm1', ts: 7 })).toBe(false);
  });
  it('setOptionActive: 사용 종료·다시 사용, 마지막 사용 중 항목은 끄지 않는다', async () => {
    const { raw, db } = setup();
    raw.exec("UPDATE job_options SET active = 0 WHERE kind = 'location' AND code <> 'seoul' AND code <> 'busan'");
    const set = (code: string, active: boolean) => setOptionActive(db, { kind: 'location', code, active, userId: 'adm1', ts: 9 });
    expect(await set('busan', false)).toBe(true);
    expect(await set('busan', false)).toBe(false); // 이미 사용 종료
    expect(await set('seoul', false)).toBe(false); // 마지막 하나
    expect(raw.prepare("SELECT active FROM job_options WHERE kind='location' AND code='seoul'").get()!.active).toBe(1);
    expect(await set('busan', true)).toBe(true);
    expect(await set('busan', true)).toBe(false); // 이미 사용 중
    expect(await set('ghost', false)).toBe(false);
    // 다른 종류의 사용 중 항목 수는 상관없다
    expect(await setOptionActive(db, { kind: 'industry', code: 'trade', active: false, userId: 'adm1', ts: 9 })).toBe(true);
  });
  it('countOptionUsage: 종류·code 별 공고 수 (상태와 관계없이)', async () => {
    const { raw, db } = setup();
    raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜기업','kr_entity','verified',0)");
    raw.exec(`INSERT INTO jobs (id, company_id, created_by, status, role_category, industry, location, created_at, updated_at) VALUES
      ('j1','c1','adm1','published','sales','trade','seoul',0,0), ('j2','c1','adm1','draft','sales',NULL,'seoul',0,0), ('j3','c1','adm1','closed',NULL,'trade','busan',0,0)`);
    const got = (await countOptionUsage(db)).map((r) => `${r.kind}:${r.code}=${r.n}`).sort();
    expect(got).toEqual(['industry:trade=2', 'location:busan=1', 'location:seoul=2', 'role_category:sales=2']);
  });
});

// ── 화면 (실제 SQLite + 세션만 가짜)

describe.skipIf(!DatabaseSync)('/admin/options 와 공개 화면', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const JOB_ID = '0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f';
  function world(role: string | null) {
    const raw = migrated();
    raw.exec("INSERT INTO users (id, email, role, created_at) VALUES ('adm1','a@example.test','admin',0)");
    raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜기업','kr_entity','verified',0)");
    raw.exec(`INSERT INTO jobs (id, company_id, created_by, title_ko, status, published_at, industry, location, created_at, updated_at)
              VALUES ('${JOB_ID}','c1','adm1','영업 담당','published',${NOW - 10},'trade','seoul',0,0)`);
    agreeRequired(raw, 'adm1'); // T-11 동의 확인을 통과하게 (구직자·기업 역할로 바꿔 쓰는 세션도 이 id 다)
    const inner = d1(raw);
    const session = role ? { id: 'adm1', email: 'a@example.test', role, locale: 'ko', mfa: role === 'admin' ? 1 : 0 } : null;
    const db = {
      prepare(sql: string) {
        if (sql.includes('FROM sessions')) {
          const st = { bind: () => st, first: async () => session };
          return st;
        }
        return inner.prepare(sql);
      },
    };
    return { raw, env: { APP_ENV: 'dev', DB: db, SESSION_PEPPER: 'test', REGISTRATION_NO: '', FLAG_PRODUCTION_JOBS: 'off' } as never };
  }
  const headers = (extra: Record<string, string> = {}) => ({ cookie: 'sid=abc', ...extra });
  const get = (w: ReturnType<typeof world>, path: string, h: Record<string, string> = headers()) =>
    app.fetch(new Request(`http://localhost${path}`, { headers: h }) as never, w.env);
  const post = (w: ReturnType<typeof world>, path: string, body: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST', body: new URLSearchParams(body),
      headers: headers({ origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }),
    }) as never, w.env);

  it('비로그인은 로그인 화면으로, 구직자·기업 담당자는 403 (GET·POST)', async () => {
    const anon = world(null);
    const r0 = await get(anon, '/admin/options', {});
    expect([r0.status, r0.headers.get('location')]).toEqual([302, '/login']);
    for (const role of ['seeker', 'company']) {
      const w = world(role);
      expect((await get(w, '/admin/options')).status, role).toBe(403);
      expect((await post(w, '/admin/options/industry/trade/retire')).status, role).toBe(403);
      expect(w.raw.prepare("SELECT active FROM job_options WHERE kind='industry' AND code='trade'").get()!.active).toBe(1);
    }
  });
  it('GET: 세 구역, 항목·사용 수·안내, 삭제 기능 없음', async () => {
    const w = world('admin');
    const res = await get(w, '/admin/options');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const k of ['role_category', 'industry', 'location']) expect(html).toContain(`id="${k}"`);
    expect(html).toContain('action="/admin/options/industry/trade/retire"');
    expect(html).toContain('action="/admin/options/industry/add"');
    expect(html).not.toMatch(/delete/i);
    expect(html).toContain('60초');
    expect(html).toContain('바꿀 수 없습니다');
    // 무역(trade) 은 공고 1건
    expect(html).toMatch(/<code>trade<\/code>[\s\S]*?<td>1<\/td>/);
  });
  it('추가 → 중복·형식 오류는 400 과 안내, 이름은 이스케이프', async () => {
    const w = world('admin');
    const ok = await post(w, '/admin/options/industry/add', { code: 'semiconductor', label_ko: '<b>반도체</b>', label_zh: '半导体', sort: '170' });
    expect([ok.status, ok.headers.get('location')]).toEqual([302, '/admin/options?ok=added#industry']);
    const html = await (await get(w, '/admin/options')).text();
    expect(html).not.toContain('<b>반도체</b>');
    expect(html).toContain('&lt;b&gt;반도체&lt;/b&gt;');
    const dup = await post(w, '/admin/options/industry/add', { code: 'trade', label_ko: '무역2', label_zh: '贸易2', sort: '1' });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('같은 코드가 이미 있습니다');
    const bad = await post(w, '/admin/options/industry/add', { code: 'Bad Code', label_ko: 'x', label_zh: 'x', sort: '1' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('형식이 맞지 않습니다');
    expect((await post(w, '/admin/options/salary/add', { code: 'abc', label_ko: 'x', label_zh: 'x', sort: '1' })).status).toBe(404);
    expect(w.raw.prepare("SELECT COUNT(*) AS n FROM job_options WHERE kind='industry'").get()!.n).toBe(17);
  });
  it('사용 종료해도 기존 공고의 이름은 보이고, 검색 칸·검색 값에서는 빠진다', async () => {
    const w = world('admin');
    w.raw.exec(`INSERT INTO site_settings (key, value, updated_at) VALUES ('public_job_filters','["industry","location"]',0)`);
    expect((await post(w, '/admin/options/industry/trade/retire')).status).toBe(302);
    // 공개 화면은 비로그인으로
    const list = await get(w, '/jobs', {});
    const html = await list.text();
    expect(html).toContain('무역');                              // 목록 줄의 이름
    expect(html).not.toContain('<option value="trade"');          // 검색 칸에는 없음
    expect(html).toContain('<option value="battery"');
    const detail = await (await get(w, `/jobs/${JOB_ID}`, {})).text();
    expect(detail).toContain('무역');
    const forged = await get(w, '/jobs?industry=trade&location=seoul', {});
    expect([forged.status, forged.headers.get('location')]).toEqual([302, '/jobs?location=seoul']);
    // 중국어 화면은 중국어 이름
    const zh = await (await get(w, `/jobs/${JOB_ID}`, { cookie: 'lang=zh' })).text();
    expect(zh).toContain('贸易');
    expect(zh).toContain('首尔');
  });
  it('이름을 고치면 기존 공고에 새 이름이 보인다', async () => {
    const w = world('admin');
    expect((await post(w, '/admin/options/industry/trade/edit', { label_ko: '무역·수출입', label_zh: '贸易', sort: '90' })).status).toBe(302);
    expect(await (await get(w, `/jobs/${JOB_ID}`, {})).text()).toContain('무역·수출입');
    const bad = await post(w, '/admin/options/industry/trade/edit', { label_ko: '', label_zh: 'x', sort: '90' });
    expect(bad.status).toBe(400);
    expect((await post(w, '/admin/options/industry/ghost/edit', { label_ko: 'x', label_zh: 'x', sort: '1' })).status).toBe(404);
  });
  it('마지막 사용 중 항목은 사용 종료할 수 없다 (400, 그대로)', async () => {
    const w = world('admin');
    w.raw.exec("UPDATE job_options SET active = 0 WHERE kind = 'location' AND code <> 'seoul'");
    const res = await post(w, '/admin/options/location/seoul/retire');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('마지막으로 남은 사용 중 항목');
    expect(w.raw.prepare("SELECT active FROM job_options WHERE kind='location' AND code='seoul'").get()!.active).toBe(1);
    expect((await post(w, '/admin/options/location/busan/restore')).status).toBe(302);
    expect((await post(w, '/admin/options/location/busan/restore')).status).toBe(400);
  });
});

describe('공고 작성 폼의 선택 칸', async () => {
  const { JobFormPage } = await import('../src/views/jobs');
  const html = (selectable: ReturnType<typeof selectableAll>, industry = '') =>
    String(JobFormPage({ locale: 'ko', action: '/x', input: { ...EMPTY_JOB_INPUT, industry }, errors: [], productionJobs: false, options: SAMPLE, selectable }));
  const industryOptions = (h: string) => [...h.split('<select name="industry">')[1]!.split('</select>')[0]!.matchAll(/<option value="([a-z_]*)"/g)].map((m) => m[1]);
  it('새 공고: 사용 중인 항목만', () => {
    expect(industryOptions(html(selectableAll(SAMPLE)))).toEqual(['', 'auto', 'battery']);
  });
  it('편집: 저장된 사용 종료 값이 "(사용 종료)" 표시로 선택되어 있다', () => {
    const h = html(selectableAll(SAMPLE, { industry: 'trade' }), 'trade');
    expect(industryOptions(h)).toEqual(['', 'auto', 'battery', 'trade']);
    expect(h).toContain('<option value="trade" selected="">무역 (사용 종료)</option>');
  });
});
