-- 지원서 보관 기간을 관리자가 바꿀 수 있게 한다 (T-12c). 개인정보를 넣지 않는다.
--
-- 지원할 때의 지원서 보관 일수(보관 기간 설정 application_keep_days, 공고 마감 확인 후 N일)를 지원마다 남긴다.
-- 예약 작업은 지원마다 실제 기간 = MIN(COALESCE(keep_days, 180), 지금 설정) 을 쓴다 (src/db/maintenance.ts):
-- 기간을 줄이면 모두에게 적용되고(더 일찍 지움), 늘리면 그 뒤에 낸 지원에만 적용된다 (예전 지원에 소급하지 않는다).
-- NULL = 이 마이그레이션 전에 낸 지원 → 그때 개인정보처리방침이 약속한 180일 (lib/retention.LEGACY_APPLICATION_KEEP_DAYS).
ALTER TABLE applications ADD COLUMN keep_days INTEGER;
