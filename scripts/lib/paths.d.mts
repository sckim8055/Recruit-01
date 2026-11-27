export declare const DEFAULT_DATA_DIR: string;
export declare function dataPaths(pe?: Record<string, string | undefined>, platform?: string): { dataDir: string; filesDir: string; backupDir: string };
export declare function pgBin(pe?: Record<string, string | undefined>, platform?: string): string;
export declare function pgTool(name: string, pe?: Record<string, string | undefined>, platform?: string): string;
