// 보관 기간 설정 읽기 (T-12c). site_settings 의 'retention' 한 줄(기본 키 읽기 한 번)을 lib/retention.parseRetention 으로 해석한다.
// 따로 캐시하지 않는다 (메모리 전역 없음) — 읽는 곳: 예약 작업 실행마다 한 번, 로그인한 회원의 요청마다 한 번(동의 확인),
// /privacy·/consent·지원 화면(캐시에 없을 때).
import { getSetting } from '../db/settings';
import { parseRetention, RETENTION_SETTING, type RetentionSettings } from './retention';

export async function loadRetention(db: D1Database): Promise<RetentionSettings> {
  return parseRetention(await getSetting(db, RETENTION_SETTING));
}
