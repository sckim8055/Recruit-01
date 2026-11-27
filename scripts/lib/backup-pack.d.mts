// test/backup.test.ts 의 형식 검사용 선언 (구현은 backup-pack.mjs).
export declare function isSafeEntryName(name: unknown): boolean;
export declare function pack(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array;
export declare function unpack(buf: Uint8Array): Array<{ name: string; data: Uint8Array }>;
export declare function backupFileName(d?: Date): string;
