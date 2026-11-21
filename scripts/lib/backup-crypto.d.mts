// test/backup-crypto.test.ts 의 형식 검사용 선언 (구현은 backup-crypto.mjs).
export declare const MAGIC: Uint8Array;
export declare const DEFAULT_PARAMS: { logN: number; r: number; p: number };
export declare const MIN_PASSPHRASE: number;
export declare class BackupDecryptError extends Error {}
export declare function encryptBackup(plain: Uint8Array, passphrase: string, params?: { logN: number; r: number; p: number }): Uint8Array;
export declare function decryptBackup(file: Uint8Array, passphrase: string): Uint8Array;
