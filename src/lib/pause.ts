// 점검 모드 (T-13). 변수 MAINTENANCE = "on" 이면 관리자가 아닌 모든 요청에 503 점검 안내를 보인다.
// 켜고 끄는 법: wrangler.jsonc 의 "MAINTENANCE" 를 "on"/"off" 로 바꿔 다시 배포하거나, 대시보드 → Workers → 설정 → 변수에서 바꾼다 (docs/DEPLOY.md 6-2).
//
// - 통과: 관리자 세션(TOTP 를 통과한 세션만 관리자로 인정된다 — lib/auth.loadUser), /api/health, 관리자가 로그인하는 데 필요한 주소
//   (/login*, /logout, /lang/*), /admin*(로그인하지 않았으면 원래대로 로그인 화면·403), public/ 의 정적 파일.
// - 나머지(비로그인 방문자·로그인한 구직자·기업 담당자)는 503 + Retry-After + no-store. src/index.tsx 에서 라우트(공개 화면 캐시 포함)보다 먼저
//   돌기 때문에 캐시에 저장된 공개 화면도 나가지 않는다.
// - 예약 작업(cron)은 멈추지 않는다 (scheduled 는 이 미들웨어를 거치지 않는다).
import { PUBLIC_FILES } from './static-files';

export const isMaintenanceOn = (v: unknown): boolean => typeof v === 'string' && v.trim().toLowerCase() === 'on';

const PASS_EXACT = new Set(['/api/health', '/login', '/logout', '/admin']);
const PASS_PREFIX = ['/login/', '/lang/', '/admin/'];

/** 점검 중에도 통과시키는 주소인가. */
export const maintenanceExempt = (path: string): boolean =>
  PASS_EXACT.has(path) || PASS_PREFIX.some((p) => path.startsWith(p)) || PUBLIC_FILES.has(path);

/** 이 요청에 점검 안내(503)를 보여야 하는가. 순수 함수. */
export function maintenanceBlocks(flag: unknown, role: string | null, path: string): boolean {
  if (!isMaintenanceOn(flag)) return false;
  if (role === 'admin') return false;
  return !maintenanceExempt(path);
}

/** 브라우저·검색엔진에 다시 와 볼 시간(초). */
export const MAINTENANCE_RETRY_AFTER = 1800;
