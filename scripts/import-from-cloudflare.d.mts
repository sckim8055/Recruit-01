// test/import.test.ts · test/storage.test.ts 의 형식 검사용 선언 (구현은 import-from-cloudflare.mjs).
export interface Client { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }
export interface TableReport { table: string; source: number; inserted: number; existing: number; replaced: number; conflicts: number; errors: number }
export interface ImportReport {
  ok: boolean; committed: boolean; tables: TableReport[]; problems: string[]; conflicts: Array<{ table: string; id: string; constraint: string }>;
  skipped: string[]; unknown: string[]; sequences?: number;
}
export declare const DEFAULTS: { d1Name: string; d1Id: string; bucket: string };
export declare const TABLE_ORDER: string[];
export declare const SKIP_TABLES: string[];
export declare const ENCRYPTED_COLUMNS: Array<[string, string]>;
export declare function isSafeKey(k: unknown): boolean;
export declare function loadExport(sql: string): Promise<any>;
export declare function sqliteTables(sqlite: any): string[];
export declare function importKey(b64: string): Promise<CryptoKey>;
export declare function canDecryptText(key: CryptoKey, stored: string): Promise<boolean>;
export declare function canDecryptFile(key: CryptoKey, bytes: Uint8Array, fileKey: string): Promise<boolean>;
export declare function checkEncKey(sqlite: any, keyB64: string, limit?: number): Promise<{ checked: number; failed: number }>;
export declare function convertValue(v: unknown, dataType: string): unknown;
export declare function pgTables(client: Client): Promise<string[]>;
export declare function runImport(o: { client: Client; sqlite: any; dryRun: boolean; log?: (s: string) => void }): Promise<ImportReport>;
export declare function fileKeys(sqlite: any): { keys: string[]; bad: string[] };
export declare function fetchFiles(o: {
  keys: string[]; filesDir: string; fetchOne: (key: string, dest: string) => Promise<boolean>; encKey?: string; dryRun: boolean; log?: (s: string) => void;
}): Promise<{ total: number; present: number; fetched: number; missing: string[]; undecryptable: string[] }>;
export declare function wranglerCommand(pe?: Record<string, string | undefined>): [string, string[]];
export declare function writeWranglerConfig(dir: string, o: { d1Name: string; d1Id: string; bucket: string }): string;
