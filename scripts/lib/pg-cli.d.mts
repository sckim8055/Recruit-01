export declare function databaseUrl(): string;
export declare function connect(url?: string): Promise<any>;
export declare function pgEnvOf(url: string): Record<string, string>;
export declare function checksum(text: string): Promise<string>;
