import { describe, expect, it } from 'vitest';
import {
  MAX_COMPANY_SEATS, REJECT_REASON_MAX, bizNoDigits, fmtBizNo, fmtDate, hasSeatLeft, identitySnapshot, inputFromFields,
  inviteIsHq, isHttpUrl, lockedFields, ownerIsHq, parseInvite, parseVerifyAction, planCompanyEdit, readCompanyForm,
  removeCheck, statusAfterDocUpload, validateCompany, type CompanyFields, type CompanyInput,
} from '../src/lib/company';

const form = (p: Partial<CompanyInput> = {}): CompanyInput => ({
  name_ko: '테스트전자', name_zh: '测试电子', entity_type: 'kr_entity', biz_no: '124-81-00998', hq_name: '',
  entry_stage: '', industry: '', website: '', profile_ko: '', ...p,
});

const stored: CompanyFields = {
  name_ko: '테스트전자', name_zh: '测试电子', entity_type: 'kr_entity', biz_no: '1248100998', hq_name: '测试集团',
  entry_stage: 'operating', industry: '전자', website: 'https://example.cn', profile_ko: '소개',
};

const errFields = (r: ReturnType<typeof validateCompany>) => (r.ok ? [] : r.errors.map((e) => `${e.field}:${e.code}`));

describe('readCompanyForm', () => {
  it('공백을 자르고, 문자열이 아닌 값은 빈 값으로', () => {
    const f = readCompanyForm({ name_ko: '  가나 ', name_zh: new File([], 'x'), profile_ko: 'a\r\nb' }, true);
    expect(f.name_ko).toBe('가나');
    expect(f.name_zh).toBe('');
    expect(f.profile_ko).toBe('a\nb');
  });
  it('등록 폼에서는 기업 소개를 받지 않는다', () => {
    expect(readCompanyForm({ profile_ko: '소개' }, false).profile_ko).toBe('');
  });
});

describe('validateCompany', () => {
  it('정상 입력을 정규화한다 (사업자번호는 숫자만, 빈 값은 null)', () => {
    const r = validateCompany(form({ entry_stage: 'preparing', website: 'https://a.example' }));
    expect(r.ok && r.value).toEqual({
      name_ko: '테스트전자', name_zh: '测试电子', entity_type: 'kr_entity', biz_no: '1248100998', hq_name: null,
      entry_stage: 'preparing', industry: null, website: 'https://a.example', profile_ko: null,
    });
  });
  it('필수 항목', () => {
    expect(errFields(validateCompany(form({ name_ko: '' })))).toEqual(['name_ko:required']);
    expect(errFields(validateCompany(form({ entity_type: '' })))).toEqual(['entity_type:required']);
    expect(errFields(validateCompany(form({ entity_type: 'admin' })))).toEqual(['entity_type:invalid']);
  });
  it('한국 법인은 체크섬이 맞는 사업자등록번호가 필수', () => {
    expect(errFields(validateCompany(form({ biz_no: '' })))).toEqual(['biz_no:required']);
    expect(errFields(validateCompany(form({ biz_no: '124-81-00999' })))).toEqual(['biz_no:invalid']);
    expect(errFields(validateCompany(form({ biz_no: '124 81 00998' })))).toEqual([]);
  });
  it('중국 본사는 사업자등록번호를 저장하지 않는다', () => {
    const r = validateCompany(form({ entity_type: 'cn_hq', biz_no: 'garbage' }));
    expect(r.ok && r.value.biz_no).toBeNull();
  });
  it('진출 단계는 정해진 값만', () => {
    expect(errFields(validateCompany(form({ entry_stage: 'ipo' })))).toEqual(['entry_stage:invalid']);
  });
  it('웹사이트는 http·https 주소만', () => {
    expect(errFields(validateCompany(form({ website: 'javascript:alert(1)' })))).toEqual(['website:invalid']);
    expect(errFields(validateCompany(form({ website: 'example.com' })))).toEqual(['website:invalid']);
    expect(errFields(validateCompany(form({ website: 'http://example.com/a?b=1' })))).toEqual([]);
  });
  it('길이 제한: 이름 100자, 소개 2000자, 그 밖 200자', () => {
    expect(errFields(validateCompany(form({ name_ko: 'a'.repeat(100) })))).toEqual([]);
    expect(errFields(validateCompany(form({ name_ko: 'a'.repeat(101) })))).toEqual(['name_ko:too_long']);
    expect(errFields(validateCompany(form({ hq_name: 'a'.repeat(101) })))).toEqual(['hq_name:too_long']);
    expect(errFields(validateCompany(form({ industry: 'a'.repeat(201) })))).toEqual(['industry:too_long']);
    expect(errFields(validateCompany(form({ profile_ko: 'a'.repeat(2000) })))).toEqual([]);
    expect(errFields(validateCompany(form({ profile_ko: 'a'.repeat(2001) })))).toEqual(['profile_ko:too_long']);
    // 너무 긴 주소는 too_long 하나만
    expect(errFields(validateCompany(form({ website: 'https://a.example/' + 'a'.repeat(200) })))).toEqual(['website:too_long']);
  });
});

describe('isHttpUrl·bizNoDigits', () => {
  it('주소 검사', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('https://exa mple.com')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
  });
  it('하이픈·공백 제거', () => expect(bizNoDigits('124-81 00998')).toBe('1248100998'));
});

describe('planCompanyEdit (검증 뒤 잠금)', () => {
  it('검증 전에는 신원 항목도 고칠 수 있고 상태는 그대로', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'pending' }, form({ name_ko: '새이름' }));
    expect(p.ok && { name: p.value.name_ko, locked: p.locked, changed: p.identityChanged, next: p.nextStatus, clear: p.clearRejectReason })
      .toEqual({ name: '새이름', locked: false, changed: true, next: 'pending', clear: false });
  });
  it('검증된 기업은 신원 항목을 폼에서 받지 않는다 (현재 값 유지)', () => {
    expect(lockedFields('verified')).toEqual(['name_ko', 'name_zh', 'biz_no', 'entity_type']);
    expect(lockedFields('pending')).toEqual([]);
    expect(lockedFields('rejected')).toEqual([]);
    const p = planCompanyEdit(
      { ...stored, verify_status: 'verified' },
      form({ name_ko: '바꾼이름', name_zh: '', entity_type: 'cn_hq', biz_no: '', industry: '반도체 장비 판매' }),
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.locked).toBe(true);
    expect([p.value.name_ko, p.value.name_zh, p.value.entity_type, p.value.biz_no]).toEqual(['테스트전자', '测试电子', 'kr_entity', '1248100998']);
    expect(p.value.industry).toBe('반도체 장비 판매');
    expect(p.identityChanged).toBe(false);
    expect(p.entityChanged).toBe(false);
    expect(p.nextStatus).toBe('verified');
  });
  it('검증된 기업이 잠긴 항목에 잘못된 값을 보내도 오류가 나지 않는다 (무시)', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'verified' }, form({ name_ko: '', biz_no: 'x' }));
    expect(p.ok).toBe(true);
  });
  it('반려된 기업이 신원 항목을 고치면 다시 검증 대기, 반려 사유 삭제', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'rejected' }, form({ biz_no: '220-81-62517' }));
    expect(p.ok && [p.nextStatus, p.clearRejectReason, p.value.biz_no]).toEqual(['pending', true, '2208162517']);
  });
  it('반려된 기업이 소개만 고치면 반려 상태 유지', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'rejected' }, { ...inputFromFields(stored), profile_ko: '새 소개' });
    expect(p.ok && [p.nextStatus, p.clearRejectReason, p.identityChanged]).toEqual(['rejected', false, false]);
  });
  it('사업자 형태 변경을 알려준다', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'pending' }, form({ entity_type: 'cn_hq' }));
    expect(p.ok && [p.entityChanged, p.value.biz_no]).toEqual([true, null]);
  });
  it('검사 오류는 그대로 돌려준다', () => {
    const p = planCompanyEdit({ ...stored, verify_status: 'pending' }, form({ website: 'nope' }));
    expect(p.ok ? [] : p.errors).toEqual([{ field: 'website', code: 'invalid' }]);
  });
});

describe('상태·소속 규칙', () => {
  it('서류를 새로 올리면 반려 → 검증 대기', () => {
    expect(statusAfterDocUpload('rejected')).toBe('pending');
    expect(statusAfterDocUpload('pending')).toBe('pending');
    expect(statusAfterDocUpload('verified')).toBe('verified');
  });
  it('본사 소속 여부', () => {
    expect(ownerIsHq('cn_hq')).toBe(1);
    expect(ownerIsHq('kr_entity')).toBe(0);
    expect(inviteIsHq('kr_entity', false)).toBe(0);
    expect(inviteIsHq('kr_entity', true)).toBe(1);
    expect(inviteIsHq('cn_hq', false)).toBe(1);
  });
  it('담당자 + 대기 초대는 10명까지', () => {
    expect(MAX_COMPANY_SEATS).toBe(10);
    expect(hasSeatLeft(9, 0)).toBe(true);
    expect(hasSeatLeft(5, 5)).toBe(false);
  });
  it('자기 자신과 대표 담당자는 내보낼 수 없다', () => {
    expect(removeCheck('u1', null)).toBe('not_member');
    expect(removeCheck('u1', { user_id: 'u1', member_role: 'owner' })).toBe('self');
    expect(removeCheck('u1', { user_id: 'u2', member_role: 'owner' })).toBe('owner');
    expect(removeCheck('u1', { user_id: 'u2', member_role: 'member' })).toBe('ok');
  });
});

describe('parseInvite', () => {
  it('이메일을 소문자로, 본사 체크', () => {
    expect(parseInvite({ email: ' Kim@Example.CN ', is_hq: '1' })).toEqual({ ok: true, email: 'kim@example.cn', checkedHq: true });
    expect(parseInvite({ email: 'a@b.co' })).toEqual({ ok: true, email: 'a@b.co', checkedHq: false });
    expect(parseInvite({ email: 'not-an-email' })).toEqual({ ok: false, why: 'email_invalid' });
    expect(parseInvite({ email: `${'a'.repeat(250)}@b.co` })).toEqual({ ok: false, why: 'email_invalid' });
  });
});

describe('parseVerifyAction', () => {
  it('승인', () => expect(parseVerifyAction({ action: 'approve' })).toEqual({ ok: true, action: 'approve' }));
  it('반려는 사유 필수, 500자까지', () => {
    expect(parseVerifyAction({ action: 'reject', reason: '  ' })).toEqual({ ok: false, why: 'reason_required' });
    expect(parseVerifyAction({ action: 'reject', reason: 'a'.repeat(REJECT_REASON_MAX + 1) })).toEqual({ ok: false, why: 'reason_too_long' });
    expect(parseVerifyAction({ action: 'reject', reason: ' 서류 불일치 ' })).toEqual({ ok: true, action: 'reject', reason: '서류 불일치' });
  });
  it('그 밖의 값은 거부', () => expect(parseVerifyAction({ action: 'edit' })).toEqual({ ok: false, why: 'bad_action' }));
});

describe('표시용', () => {
  it('신원 스냅샷은 신원 항목이 바뀌면 달라진다', () => {
    expect(identitySnapshot(stored)).toBe(identitySnapshot({ ...stored, industry: 'x' } as CompanyFields));
    expect(identitySnapshot(stored)).not.toBe(identitySnapshot({ ...stored, biz_no: '2208162517' }));
  });
  it('사업자번호·날짜 형식', () => {
    expect(fmtBizNo('1248100998')).toBe('124-81-00998');
    expect(fmtBizNo(null)).toBe('');
    expect(fmtDate(0)).toBe('1970-01-01');
    expect(fmtDate(15 * 3600)).toBe('1970-01-02'); // 한국 시간 기준
    expect(fmtDate(null)).toBe('');
  });
});
