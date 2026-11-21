import { describe, expect, it } from 'vitest';
import { actorFromRows, membershipsFor } from '../src/lib/actor';

const companyRows = [
  { company_id: 'c1', is_hq: 0 },
  { company_id: 'c2', is_hq: 1 },
];
const agencyRows = [{ agency_id: 'a1' }];

describe('membershipsFor', () => {
  it('구직자·관리자는 소속 테이블을 읽지 않는다', () => {
    expect(membershipsFor('seeker')).toEqual({ company: false, agency: false });
    expect(membershipsFor('admin')).toEqual({ company: false, agency: false });
  });
  it('기업 담당자는 company_members, 헤드헌터는 agency_members 만 읽는다', () => {
    expect(membershipsFor('company')).toEqual({ company: true, agency: false });
    expect(membershipsFor('headhunter')).toEqual({ company: false, agency: true });
  });
});

describe('actorFromRows', () => {
  it('기업 담당자: 소속 기업과 본사 소속 기업을 나눈다', () => {
    expect(actorFromRows({ id: 'u1', role: 'company' }, companyRows, [])).toEqual({
      id: 'u1', role: 'company', companyIds: ['c1', 'c2'], hqCompanyIds: ['c2'], agencyIds: [],
    });
  });
  it('헤드헌터: 업체만 담긴다', () => {
    expect(actorFromRows({ id: 'u2', role: 'headhunter' }, [], agencyRows)).toEqual({
      id: 'u2', role: 'headhunter', companyIds: [], hqCompanyIds: [], agencyIds: ['a1'],
    });
  });
  it('역할에 맞지 않는 소속 행은 버린다', () => {
    const seeker = actorFromRows({ id: 's1', role: 'seeker' }, companyRows, agencyRows);
    expect(seeker).toEqual({ id: 's1', role: 'seeker', companyIds: [], hqCompanyIds: [], agencyIds: [] });
    const admin = actorFromRows({ id: 'ad', role: 'admin' }, companyRows, agencyRows);
    expect(admin.companyIds).toEqual([]);
    expect(admin.agencyIds).toEqual([]);
    expect(actorFromRows({ id: 'u1', role: 'company' }, companyRows, agencyRows).agencyIds).toEqual([]);
  });
  it('소속이 없으면 빈 배열', () => {
    expect(actorFromRows({ id: 'u3', role: 'company' }, [], [])).toEqual({
      id: 'u3', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [],
    });
  });
});
