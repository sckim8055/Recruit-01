// 보관 기간과 예약 작업의 기간 (T-12). 이 파일 한 곳에만 둔다.
//
// ★ 아래 숫자는 개인정보처리방침 3항(src/legal/privacy.ts)과 같아야 한다:
//   지원서 "공고 마감 후 180일", 사업자 서류 "확인 후 1년", 열람 기록 "2년", 동의 기록·지원 사실 "탈퇴 후에도 2년".
//   test/maintenance.test.ts 가 방침 글에 같은 숫자가 있는지 확인한다. 하나를 바꾸면 다른 쪽과 lib/consent.PRIVACY_VERSION 도 함께 바꾼다.
// 단위는 모두 초.

export const DAY = 86_400;
export const HOUR = 3_600;

/** 지원서 내용(복사본·첨부): 공고 마감(을 확인한 때)부터 180일 뒤 삭제. 방침 3항 "공고 마감 후 180일". */
export const APPLICATION_KEEP_AFTER_CLOSE = 180 * DAY;
/** 공고 마감(을 확인한 때)부터 30일이 지나도 진행 중인 지원은 'auto_closed' (상태 "채용 종료"). */
export const APPLICATION_AUTO_CLOSE_AFTER = 30 * DAY;
/** 확인(승인·반려)이 끝난 사업자 서류: 확인 후 1년 뒤 삭제. 방침 3항 "확인 후 1년". */
export const VDOC_KEEP_AFTER_REVIEW = 365 * DAY;
/** 열람 기록(access_log): 2년. 방침 3항 "열람 기록: 2년". */
export const ACCESS_LOG_KEEP = 730 * DAY;
/** 내용을 지운 지원 행·이벤트, 철회된 동의 기록: 2년 뒤 행 삭제. 방침 3항 "동의 기록, 지원했다는 사실 … 2년". */
export const ERASED_ROW_KEEP = 730 * DAY;
/** 메일 발송 기록(email_log, 주소 해시·템플릿·결과): 1년. */
export const EMAIL_LOG_KEEP = 365 * DAY;
/** 마감일 없는 게재 중 공고: 마지막 저장 후 30일이면 자동 마감. */
export const JOB_STALE_AFTER = 30 * DAY;
/** 자동 마감 3일 전에 기업 담당자에게 안내 메일. */
export const JOB_CLOSE_NOTICE_BEFORE = 3 * DAY;
/** R2 고아 객체: 올라온 지 24시간이 지난 것만 지운다 (올리는 중·DB 쓰기 전의 객체를 지우지 않게). */
export const ORPHAN_MIN_AGE = 24 * HOUR;

/** 방침 글에 있어야 하는 숫자 표현 (test 용). */
export const PRIVACY_TEXT_NUMBERS = {
  ko: { application: '180일', vdoc: '1년', accessLog: '2년', erased: '2년' },
  zh: { application: '180天', vdoc: '1年', accessLog: '2年', erased: '2年' },
} as const;
