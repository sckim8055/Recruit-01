import { describe, expect, it } from 'vitest';
import { canSeeZhSummary, canViewApplication, type Actor } from '../src/lib/authz';
import { decryptText, encryptText, importEncKey, randomCode } from '../src/lib/crypto';
import { contactEmailProblem, findBannedPhrases, nextStatus, publishBlocks, techLeakFlag, type PublishInput } from '../src/lib/rules';

const flagsOff = { productionJobs: false, headhunterPosting: false, resumeZhSummary: false, paidLabel: false };
const ops = ['kimbbob.com', 'nexthub.me'];
const goodJob: PublishInput['job'] = {
  job_family: 'office', title_ko: '영업 매니저', body_ko: '한국 시장 B2B 영업', localize_status: 'approved',
  contact_email: 'hr@example-corp.cn', salary_basis: 'severance_excluded', salary_min: 5000,
  agency_id: null, review_flag: null, review_cleared_by: null,
};
const base: PublishInput = {
  job: goodJob, companyVerified: true, agencyVerified: false, flags: flagsOff,
  appEnv: 'production', registrationNo: 'J0000000000000', operatorDomains: ops,
};

describe('publishBlocks', () => {
  it('조건을 모두 갖추면 게재할 수 있다', () => expect(publishBlocks(base)).toEqual([]));
  it('검증 전 기업은 게재 불가', () => expect(publishBlocks({ ...base, companyVerified: false })).toContain('company_not_verified'));
  it('신고번호 없이는 운영에서 게재 불가', () => expect(publishBlocks({ ...base, registrationNo: ' ' })).toContain('not_registered'));
  it('테스트 환경은 신고번호 없이도 가능', () => expect(publishBlocks({ ...base, appEnv: 'test', registrationNo: '' })).toEqual([]));
  it('운영자 주소는 연락처로 쓸 수 없다', () =>
    expect(publishBlocks({ ...base, job: { ...goodJob, contact_email: 'me@mail.kimbbob.com' } })).toContain('contact_is_operator'));
  it('생산직은 플래그가 꺼져 있으면 불가', () =>
    expect(publishBlocks({ ...base, job: { ...goodJob, job_family: 'production' } })).toContain('production_jobs_disabled'));
  it('헤드헌터 공고는 플래그가 꺼져 있으면 불가', () =>
    expect(publishBlocks({ ...base, job: { ...goodJob, agency_id: 'a1' } })).toContain('agency_posting_disabled'));
  it('연봉을 적으면 퇴직금 기준이 필수', () =>
    expect(publishBlocks({ ...base, job: { ...goodJob, salary_basis: null } })).toContain('salary_basis_missing'));
  it('금지 표현이 있으면 불가', () =>
    expect(publishBlocks({ ...base, job: { ...goodJob, body_ko: '취업추천 해드립니다' } })).toContain('banned_phrase'));
  it('기술유출 필터에 걸리면 관리자 통과 전까지 불가', () => {
    const j = { ...goodJob, review_flag: 'core_tech_rnd' };
    expect(publishBlocks({ ...base, job: j })).toContain('needs_admin_review');
    expect(publishBlocks({ ...base, job: { ...j, review_cleared_by: 'admin1' } })).toEqual([]);
  });
});

describe('필터', () => {
  it('금지 표현', () => expect(findBannedPhrases('무료 취업 상담')).toEqual(['취업 상담']));
  it('핵심기술 R&D', () => expect(techLeakFlag('배터리 셀 공정 엔지니어 모집')).toBe('core_tech_rnd'));
  it('특정 기업 출신 겨냥', () => expect(techLeakFlag('삼성전자 출신 우대')).toBe('targeted_company'));
  it('일반 영업직은 통과', () => expect(techLeakFlag('전기차 영업 매니저, 중국어 가능자')).toBeNull());
  it('연락처 누락', () => expect(contactEmailProblem('', ops)).toBe('contact_missing'));
});

describe('nextStatus', () => {
  it('앞으로만 간다', () => {
    expect(nextStatus('submitted', 'viewed')).toBe('viewed');
    expect(nextStatus('interview', 'viewed')).toBe('interview');
    expect(nextStatus('viewed', 'interview_mail')).toBe('interview');
  });
  it('끝난 지원은 바뀌지 않는다', () => expect(nextStatus('rejected', 'interview_mail')).toBe('rejected'));
});

describe('authz', () => {
  const job = { company_id: 'c1', agency_id: null, created_by: 'u9' };
  const app = { seeker_id: 's1', job, cross_border_consent_at: null as number | null };
  const mk = (p: Partial<Actor>): Actor => ({ id: 'x', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });
  it('다른 구직자는 볼 수 없다', () => expect(canViewApplication(mk({ role: 'seeker', id: 's2' }), app).allow).toBe(false));
  it('한국법인 담당자는 볼 수 있다', () => expect(canViewApplication(mk({ companyIds: ['c1'] }), app).allow).toBe(true));
  it('본사 담당자는 국외 이전 동의가 있어야 한다', () => {
    const hq = mk({ companyIds: ['c1'], hqCompanyIds: ['c1'] });
    expect(canViewApplication(hq, app)).toEqual({ allow: false, why: 'no_cross_border_consent' });
    expect(canViewApplication(hq, { ...app, cross_border_consent_at: 1 }).allow).toBe(true);
  });
  it('다른 기업은 볼 수 없다', () => expect(canViewApplication(mk({ companyIds: ['c2'] }), app).allow).toBe(false));
  it('관리자는 사유가 필요하다', () => expect(canViewApplication(mk({ role: 'admin' }), app)).toEqual({ allow: true, needsReason: true }));
  it('중국어 요약은 구직자 승인 전에는 기업에 보이지 않는다', () => {
    const a = mk({ companyIds: ['c1'] });
    expect(canSeeZhSummary(a, { ...app, cross_border_consent_at: 1, summary_approved_at: null })).toBe(false);
    expect(canSeeZhSummary(a, { ...app, cross_border_consent_at: 1, summary_approved_at: 2 })).toBe(true);
  });
});

describe('crypto', () => {
  it('암호화한 값을 되돌릴 수 있고 매번 다른 암호문이 나온다', async () => {
    const key = await importEncKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const a = await encryptText(key, '홍길동 010-0000-0000');
    const b = await encryptText(key, '홍길동 010-0000-0000');
    expect(a).not.toBe(b);
    expect(await decryptText(key, a)).toBe('홍길동 010-0000-0000');
  });
  it('인증코드는 6자리 숫자', () => expect(randomCode()).toMatch(/^\d{6}$/));
});
