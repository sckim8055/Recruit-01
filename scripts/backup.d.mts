// test/backup.test.ts 의 형식 검사용 선언 (구현은 backup.mjs · restore.mjs).
export declare function listFiles(dir: string): string[];
export declare function createBackup(o: {
  dump: () => Promise<Uint8Array>; filesDir: string; backupDir: string; passphrase: string; date?: Date; params?: { logN: number; r: number; p: number };
}): Promise<{ file: string; files: number; dbBytes: number }>;
export declare function pruneBackups(dir: string, keep: number): number;
export declare function pgDump(url: string, tool?: string): Promise<Uint8Array>;
