export declare const SCHEMA_MIGRATIONS_DDL: string;
export declare const MIGRATIONS_DIR: string;
export declare function migrationFiles(dir?: string): string[];
export declare function migrate(client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }, dir?: string, log?: (s: string) => void): Promise<{ applied: string[]; skipped: number }>;
