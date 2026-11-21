import { describe, expect, it } from 'vitest';
import { canManageCompany, canManageMembers, canViewVerificationDoc, type Actor } from '../src/lib/authz';
import { checkUpload, isDocType, privateFileHeaders, sniffType } from '../src/lib/files';
import { isValidBizNo, verifyBlocks } from '../src/lib/rules';

const mk = (p: Partial<Actor>): Actor => ({ id: 'x', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });

describe('사업자등록번호', () => {
  it('체크섬이 맞는 번호만 통과', () => {
    expect(isValidBizNo('124-81-00998')).toBe(true);   // 공개된 실제 법인 번호 형식 예
    expect(isValidBizNo('1248100998')).toBe(true);
    expect(isValidBizNo('1248100999')).toBe(false);
    expect(isValidBizNo('12345')).toBe(false);
    expect(isValidBizNo('abcdefghij')).toBe(false);
  });
});

describe('verifyBlocks', () => {
  it('한국법인은 사업자등록 서류와 유효한 번호가 있어야 승인 가능', () => {
    expect(verifyBlocks({ entity_type: 'kr_entity', biz_no: '1248100998', docTypes: ['biz_cert'] })).toEqual([]);
    expect(verifyBlocks({ entity_type: 'kr_entity', biz_no: '1248100998', docTypes: [] })).toEqual(['no_document']);
    expect(verifyBlocks({ entity_type: 'kr_entity', biz_no: null, docTypes: ['biz_cert'] })).toEqual(['biz_no_missing']);
    expect(verifyBlocks({ entity_type: 'kr_entity', biz_no: '1111111111', docTypes: ['cn_license'] })).toEqual(['no_document', 'biz_no_invalid']);
  });
  it('중국 본사는 영업집조가 있어야 승인 가능', () => {
    expect(verifyBlocks({ entity_type: 'cn_hq', biz_no: null, docTypes: ['cn_license'] })).toEqual([]);
    expect(verifyBlocks({ entity_type: 'cn_hq', biz_no: null, docTypes: ['biz_cert'] })).toEqual(['no_document']);
  });
});

describe('기업 권한', () => {
  it('자기 기업만 관리할 수 있고 관리자는 관리(수정)하지 못한다', () => {
    expect(canManageCompany(mk({ companyIds: ['c1'] }), 'c1')).toBe(true);
    expect(canManageCompany(mk({ companyIds: ['c2'] }), 'c1')).toBe(false);
    expect(canManageCompany(mk({ role: 'admin' }), 'c1')).toBe(false);
    expect(canManageCompany(mk({ role: 'seeker', companyIds: ['c1'] }), 'c1')).toBe(false);
  });
  it('담당자 관리는 대표 담당자만', () => {
    const a = mk({ companyIds: ['c1'] });
    expect(canManageMembers(a, 'c1', 'owner')).toBe(true);
    expect(canManageMembers(a, 'c1', 'member')).toBe(false);
    expect(canManageMembers(a, 'c2', 'owner')).toBe(false);
  });
  it('검증 서류는 올린 기업과 관리자만 본다', () => {
    const doc = { owner_type: 'company' as const, owner_id: 'c1' };
    expect(canViewVerificationDoc(mk({ companyIds: ['c1'] }), doc)).toBe(true);
    expect(canViewVerificationDoc(mk({ companyIds: ['c2'] }), doc)).toBe(false);
    expect(canViewVerificationDoc(mk({ role: 'admin' }), doc)).toBe(true);
    expect(canViewVerificationDoc(mk({ role: 'seeker' }), doc)).toBe(false);
    expect(canViewVerificationDoc(mk({ role: 'headhunter', agencyIds: ['c1'] }), doc)).toBe(false);
    expect(canViewVerificationDoc(mk({ role: 'headhunter', agencyIds: ['a1'] }), { owner_type: 'agency', owner_id: 'a1' })).toBe(true);
  });
});

describe('파일', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  it('내용으로 종류를 판별한다', () => {
    expect(sniffType(pdf)?.ext).toBe('pdf');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe('png');
    expect(sniffType(new TextEncoder().encode('<html><script>'))).toBeNull();
    expect(sniffType(new Uint8Array([0x4d, 0x5a]))).toBeNull(); // exe
  });
  it('확장자를 속여도 내용이 다르면 거부한다', async () => {
    expect(await checkUpload(new File(['<script>alert(1)</script>'], 'cert.pdf', { type: 'application/pdf' }))).toEqual({ ok: false, why: 'bad_type' });
    expect(await checkUpload(new File([], 'a.pdf'))).toEqual({ ok: false, why: 'empty' });
    expect(await checkUpload('not a file')).toEqual({ ok: false, why: 'empty' });
    const ok = await checkUpload(new File([pdf], 'whatever.txt'));
    expect(ok.ok && ok.type.ext).toBe('pdf');
  });
  it('서류 종류는 정해진 값만', () => {
    expect(isDocType('biz_cert')).toBe(true);
    expect(isDocType('../../etc')).toBe(false);
  });
  it('비공개 파일 헤더', () => {
    const h = privateFileHeaders('application/pdf', 'document.pdf');
    expect(h.get('cache-control')).toBe('private, no-store');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('content-disposition')).toContain('attachment');
  });
});
