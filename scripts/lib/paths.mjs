// 데이터 폴더 (T-19): 운영자 스크립트(백업·가져오기)가 서버(src/server-env.ts readServerConfig)와 같은 규칙으로 정한다.
//   DATA_DIR (기본 F:\works\Recruit-01-data) → 첨부파일 DATA_DIR\files, 백업 BACKUP_DIR (기본 DATA_DIR\backups)
// test/backup.test.ts 가 서버의 규칙과 같은지 본다.
import { join, resolve, win32 } from 'node:path';

export const DEFAULT_DATA_DIR = 'F:\\works\\Recruit-01-data';

export function dataPaths(pe = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const dataDir = (pe.DATA_DIR ?? '').trim() || (win ? DEFAULT_DATA_DIR : '');
  if (!dataDir) throw new Error('.env 에 DATA_DIR 이 없습니다 (docs/DEPLOY.md 3장).');
  const abs = (p) => (win ? win32.resolve(p) : resolve(p));
  return { dataDir, filesDir: abs(join(dataDir, 'files')), backupDir: abs((pe.BACKUP_DIR ?? '').trim() || join(dataDir, 'backups')) };
}

/** pg_dump·pg_restore 가 있는 폴더 (PG_BIN). Windows 기본은 PostgreSQL 16 설치 폴더, 그 밖은 PATH. */
export function pgBin(pe = process.env, platform = process.platform) {
  const v = (pe.PG_BIN ?? '').trim();
  if (v) return v;
  return platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\16\\bin' : '';
}

export const pgTool = (name, pe = process.env, platform = process.platform) => {
  const dir = pgBin(pe, platform);
  const exe = platform === 'win32' ? `${name}.exe` : name;
  return dir ? join(dir, exe) : exe;
};
