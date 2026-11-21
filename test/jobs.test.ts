import { describe, expect, it } from 'vitest';
import {
  EMPTY_JOB_INPUT, digitDiff, digitRuns, hasContactInText, inputFromJob, parseKstDate, kstDate, planJobSave, publishInputOf,
  readBlockReason, readJobForm, readKoreanForm, readRev, reviewAfterSave, validateJob, type JobInput, type JobState,
} from '../src/lib/jobs';
import { buildOptionSet, selectableAll } from '../src/lib/options';
import { publishBlocks } from '../src/lib/rules';
import { optionRows } from './option-seed';

const flagsOff = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
const NOW = parseKstDate('2026-11-21')! - 86399; // 2026-11-21 00:00 KST
// 직무·업계·근무지 목록은 T-06e 부터 DB(job_options) 에 있다. 기본 행(0007 = test/option-seed.ts)으로 만든 새 공고용 목록을 넘긴다.
const vctx = { flags: flagsOff, operatorDomains: ['kimbbob.com', 'nexthub.me'], now: NOW, options: selectableAll(buildOptionSet(optionRows())) };

const form = (p: Partial<JobInput> = {}): JobInput => ({
  ...EMPTY_JOB_INPUT,
  title_zh: '韩国市场销售经理', source_zh: '负责韩国市场B2B销售。\n要求3年以上经验。', ...p,
});
const errs = (r: ReturnType<typeof validateJob>) => (r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`));

describe('readJobForm', () => {
  it('공백을 자르고, 제목은 한 줄, 본문 줄바꿈은 \\n', () => {
    const f = readJobForm({ title_zh: ' 标题\r\n第二行 ', source_zh: 'a\r\nb', salary_min: new File([], 'x') });
    expect([f.title_zh, f.source_zh, f.salary_min]).toEqual(['标题 第二行', 'a\nb', '']);
  });
});

describe('validateJob', () => {
  it('최소 입력(제목·본문)만으로 저장할 수 있다', () => {
    const r = validateJob(form(), vctx);
    expect(r.ok && r.value).toMatchObject({ job_family: 'office', salary_min: null, contact_email: null, work_hours: null, closes_at: null });
  });
  it('제목·본문 필수, 길이 제한 120·8000', () => {
    expect(errs(validateJob(form({ title_zh: '', source_zh: '' }), vctx))).toEqual(['title_zh:required', 'source_zh:required']);
    expect(errs(validateJob(form({ title_zh: '字'.repeat(120), source_zh: '字'.repeat(8000) }), vctx))).toEqual([]);
    expect(errs(validateJob(form({ title_zh: '字'.repeat(121), source_zh: '字'.repeat(8001) }), vctx))).toEqual(['title_zh:too_long', 'source_zh:too_long']);
  });
  it('원문에 이메일·전화번호를 적으면 거부한다 (엔진에 연락처가 가지 않게)', () => {
    expect(errs(validateJob(form({ source_zh: '简历发送到 hr@example.cn' }), vctx))).toEqual(['source_zh:contact_in_text']);
    expect(errs(validateJob(form({ source_zh: '电话 13812345678' }), vctx))).toEqual(['source_zh:contact_in_text']);
    expect(errs(validateJob(form({ title_zh: '联系 010-1234-5678' }), vctx))).toEqual(['title_zh:contact_in_text']);
  });
  it('생산직은 플래그가 꺼져 있으면 받지 않는다', () => {
    expect(errs(validateJob(form({ job_family: 'production' }), vctx))).toEqual(['job_family:invalid']);
    const on = validateJob(form({ job_family: 'production' }), { ...vctx, flags: { ...flagsOff, productionJobs: true } });
    expect(on.ok && on.value.job_family).toBe('production');
  });
  it('선택 항목은 정해진 값만', () => {
    expect(errs(validateJob(form({ role_category: 'sales', industry: 'battery', location: 'seoul', chinese_level: 'business', report_line: 'cn_hq' }), vctx))).toEqual([]);
    expect(errs(validateJob(form({ role_category: 'spy', location: 'beijing' }), vctx))).toEqual(['role_category:invalid', 'location:invalid']);
  });
  it('연봉: 정수(쉼표 허용), 최소 ≤ 최대, 연봉을 적으면 퇴직금 기준 필수', () => {
    const ok = validateJob(form({ salary_min: '4,000', salary_max: '5000', salary_basis: 'severance_excluded' }), vctx);
    expect(ok.ok && [ok.value.salary_min, ok.value.salary_max]).toEqual([4000, 5000]);
    expect(errs(validateJob(form({ salary_min: '4000' }), vctx))).toEqual(['salary_basis:required']);
    expect(errs(validateJob(form({ salary_max: '5000', salary_basis: 'severance_included' }), vctx))).toEqual(['salary_min:required']);
    expect(errs(validateJob(form({ salary_min: '6000', salary_max: '5000', salary_basis: 'severance_included' }), vctx))).toEqual(['salary_max:range']);
    expect(errs(validateJob(form({ salary_min: '4천', salary_basis: 'severance_included' }), vctx))).toEqual(['salary_min:invalid']);
    expect(errs(validateJob(form({ salary_min: '0', salary_basis: 'severance_included' }), vctx))).toEqual(['salary_min:range']);
  });
  it('근무시간: 시작·종료 둘 다 HH:MM', () => {
    const ok = validateJob(form({ work_start: '09:00', work_end: '18:00' }), vctx);
    expect(ok.ok && ok.value.work_hours).toBe('09:00-18:00');
    expect(errs(validateJob(form({ work_start: '09:00' }), vctx))).toEqual(['work_end:required']);
    expect(errs(validateJob(form({ work_start: '25:00', work_end: '18:00' }), vctx))).toEqual(['work_start:invalid']);
  });
  it('연락처: 운영자 도메인 거부, 소문자로 저장', () => {
    expect(errs(validateJob(form({ contact_email: 'me@kimbbob.com' }), vctx))).toEqual(['contact_email:operator_email']);
    expect(errs(validateJob(form({ contact_email: 'nope' }), vctx))).toEqual(['contact_email:invalid']);
    const ok = validateJob(form({ contact_email: 'HR@Example.CN' }), vctx);
    expect(ok.ok && ok.value.contact_email).toBe('hr@example.cn');
  });
  it('마감일: 오늘 이후 1년 안', () => {
    expect(errs(validateJob(form({ closes_at: '2026-11-21' }), vctx))).toEqual([]);
    expect(errs(validateJob(form({ closes_at: '2026-11-20' }), vctx))).toEqual(['closes_at:past']);
    expect(errs(validateJob(form({ closes_at: '2028-01-01' }), vctx))).toEqual(['closes_at:range']);
    expect(errs(validateJob(form({ closes_at: '2026-02-30' }), vctx))).toEqual(['closes_at:invalid']);
  });
  it('저장 값 → 폼 값 왕복', () => {
    const r = validateJob(form({ salary_min: '4000', salary_basis: 'severance_excluded', work_start: '09:30', work_end: '18:30', closes_at: '2026-12-31' }), vctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = inputFromJob(r.value);
    expect([back.salary_min, back.work_start, back.work_end, back.closes_at]).toEqual(['4000', '09:30', '18:30', '2026-12-31']);
  });
});

describe('날짜', () => {
  it('마감일은 그날 23:59:59 (한국 시간)', () => {
    const ts = parseKstDate('2026-12-31')!;
    expect(new Date(ts * 1000).toISOString()).toBe('2026-12-31T14:59:59.000Z');
    expect(kstDate(ts)).toBe('2026-12-31');
    expect(parseKstDate('2026/12/31')).toBeNull();
  });
});

describe('hasContactInText', () => {
  it('연봉 범위·연도 같은 숫자는 연락처로 보지 않는다', () => {
    expect(hasContactInText('年薪 5000-6000 万韩元，2026年入职，工作时间 09:00-18:00')).toBe(false);
    expect(hasContactInText('+86 138 1234 5678')).toBe(true);
    expect(hasContactInText('02-123-4567')).toBe(true);
  });
});

describe('readKoreanForm', () => {
  it('제목 한 줄, 길이 제한', () => {
    expect(readKoreanForm({ title_ko: '영업\n매니저', body_ko: '본문' })).toEqual({ ok: true, title_ko: '영업 매니저', body_ko: '본문' });
    const r = readKoreanForm({ title_ko: '', body_ko: '가'.repeat(8001) });
    expect(!r.ok && r.errors.map((e) => `${e.field}:${e.code}`)).toEqual(['title_ko:required', 'body_ko:too_long']);
  });
});

const base: JobState = {
  status: 'draft', localize_status: 'approved', title_zh: '销售经理', source_zh: '负责销售', title_ko: '영업 매니저', body_ko: '영업 담당',
  review_flag: null, review_cleared_by: null,
};
const always = () => true;
const never = () => false;

describe('planJobSave (상태 되돌리기)', () => {
  it('원문을 고치면 승인이 풀리고 review 로', () => {
    const p = planJobSave(base, { ...base, source_zh: '负责B2B销售' }, always);
    expect([p.status, p.localize_status, p.unpublished]).toEqual(['draft', 'review', false]);
  });
  it('한국어를 고쳐도 review 로', () => {
    expect(planJobSave(base, { ...base, body_ko: '영업 담당 (B2B)' }, always).localize_status).toBe('review');
  });
  it('한국어 초안이 없으면 draft', () => {
    const cur = { ...base, localize_status: 'draft' as const, title_ko: null, body_ko: null };
    expect(planJobSave(cur, { ...cur, source_zh: '改' }, always).localize_status).toBe('draft');
  });
  it('게재 중 공고의 글을 고치면 게재 중단', () => {
    const p = planJobSave({ ...base, status: 'published' }, { ...base, title_ko: '새 제목' }, always);
    expect([p.status, p.localize_status, p.unpublished]).toEqual(['draft', 'review', true]);
  });
  it('게재 중 공고의 조건만 고치면: publishBlocks 가 비어 있을 때만 게재 유지', () => {
    const cur = { ...base, status: 'published' as const };
    expect(planJobSave(cur, cur, always)).toMatchObject({ status: 'published', localize_status: 'approved', unpublished: false });
    expect(planJobSave(cur, cur, never)).toMatchObject({ status: 'draft', localize_status: 'approved', unpublished: true });
  });
  it('차단·마감 상태는 바꾸지 않는다', () => {
    expect(planJobSave({ ...base, status: 'blocked' }, { ...base, source_zh: '改' }, never).status).toBe('blocked');
    expect(planJobSave({ ...base, status: 'closed' }, { ...base, source_zh: '改' }, never).status).toBe('closed');
  });
  it('저장할 때마다 기술유출 필터를 다시 계산한다', () => {
    const p = planJobSave(base, { ...base, source_zh: '半导体工艺工程师，研发岗位' }, always);
    expect(p.review_flag).toBe('core_tech_rnd');
  });
});

describe('reviewAfterSave (관리자 검토 통과 유지·해제)', () => {
  const flagged = { ...base, source_zh: '半导体研发工程师', review_flag: 'core_tech_rnd', review_cleared_by: 'admin1' };
  it('걸린 글이 그대로면 검토 통과 유지', () =>
    expect(reviewAfterSave(flagged, flagged)).toEqual({ review_flag: 'core_tech_rnd', review_cleared_by: 'admin1' }));
  it('걸린 글이 바뀌면 검토 통과 해제', () =>
    expect(reviewAfterSave(flagged, { ...flagged, body_ko: '반도체 연구원 (수정)' })).toEqual({ review_flag: 'core_tech_rnd', review_cleared_by: null }));
  it('필터에 걸리지 않게 되면 둘 다 비운다', () =>
    expect(reviewAfterSave(flagged, { ...flagged, source_zh: '销售', title_ko: '영업', body_ko: '영업' })).toEqual({ review_flag: null, review_cleared_by: null }));
  it('특정 기업 출신 겨냥', () =>
    expect(reviewAfterSave(base, { ...base, body_ko: '삼성 출신 우대' }).review_flag).toBe('targeted_company'));
});

describe('publishInputOf', () => {
  const row = {
    job_family: 'office' as const, title_ko: '영업 매니저', body_ko: '영업', localize_status: 'approved' as const,
    contact_email: 'hr@example.cn', salary_basis: 'severance_excluded', salary_min: 4000, agency_id: null,
    review_flag: null, review_cleared_by: null,
  };
  const ctx = { companyVerified: true, flags: flagsOff, appEnv: 'test' as const, registrationNo: '', operatorDomains: ['kimbbob.com'] };
  it('조건을 갖춘 행은 막히지 않는다', () => expect(publishBlocks(publishInputOf(row, ctx))).toEqual([]));
  it('검증 전 기업·미승인·검토 대기는 publishBlocks 가 막는다', () => {
    expect(publishBlocks(publishInputOf({ ...row, localize_status: 'review', review_flag: 'core_tech_rnd' }, { ...ctx, companyVerified: false })))
      .toEqual(['company_not_verified', 'localization_not_approved', 'needs_admin_review']);
  });
  it('헤드헌터 공고(agency_id)는 업체 검증 여부와 관계없이 막힌다', () =>
    expect(publishBlocks(publishInputOf({ ...row, agency_id: 'a1' }, ctx))).toContain('agency_posting_disabled'));
});

describe('digitDiff (숫자 대조 경고)', () => {
  it('숫자 묶음 추출: 전각 숫자·천 단위 쉼표 정리', () => {
    expect(digitRuns('年薪５,０００万，3年以上，1.5倍')).toEqual(['5000', '3', '1.5']);
  });
  it('같으면 빈 결과', () => expect(digitDiff('3年以上经验，年薪5000万', '경력 3년 이상, 연봉 5,000만')).toEqual({ missing: [], extra: [] }));
  it('바뀐 숫자를 찾는다', () =>
    expect(digitDiff('3年以上经验，招聘2名', '경력 5년 이상, 2명 채용')).toEqual({ missing: ['3'], extra: ['5'] }));
  it('개수까지 비교한다', () => expect(digitDiff('9点到6点，9点开会', '9시~6시')).toEqual({ missing: ['9'], extra: [] }));
});

describe('관리자 폼', () => {
  it('차단 사유 필수, 500자까지', () => {
    expect(readBlockReason({ reason: '  ' })).toEqual({ ok: false, why: 'reason_required' });
    expect(readBlockReason({ reason: 'a'.repeat(501) })).toEqual({ ok: false, why: 'reason_too_long' });
    expect(readBlockReason({ reason: '허위 조건' })).toEqual({ ok: true, reason: '허위 조건' });
  });
  it('rev 는 정수만', () => {
    expect(readRev({ rev: '3' })).toBe(3);
    expect(readRev({ rev: '-1' })).toBeNull();
    expect(readRev({})).toBeNull();
  });
});
