// 약관·개인정보처리방침 문서의 모양. 본문은 terms.ts · privacy.ts 에 한국어·중국어로 둔다.
// 한국어가 기준이다. 중국어는 참고용 번역이며, 두 글이 다르면 한국어를 따른다고 문서에 적는다.
// 본문을 고치면 src/lib/consent.ts 의 TERMS_VERSION · PRIVACY_VERSION 을 올린다 (회원에게 다시 동의를 받는다).
// 【확인 필요】 표시가 남아 있는 동안은 운영 환경에 올리지 않는다 (test/account.test.ts 의 "문서 본문" 이 표시가 남았는지 확인한다).
export interface LegalSection { h: string; items: string[] }
export interface LegalDoc { title: string; effective: string; intro: string[]; sections: LegalSection[] }

/** 운영자 정보. 실제 값은 운영자가 확인해 채운다. */
export const OPERATOR = {
  name: 'NextHub 【확인 필요: 상호】',
  bizNo: '293-11-02630',
  representative: '【확인 필요: 대표자 이름】',
  address: '【확인 필요: 사업장 주소】',
  email: '【확인 필요: 문의 이메일】',
  privacyOfficer: '【확인 필요: 개인정보 보호책임자 이름·연락처】',
} as const;
