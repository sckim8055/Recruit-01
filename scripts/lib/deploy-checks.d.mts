// test/deploy-checks.test.ts 의 형식 검사용 선언 (구현은 deploy-checks.mjs).
export declare const PLACEHOLDER: string;
export declare const ENVS: readonly ['test', 'production'];
export type DeployEnv = 'test' | 'production';
export declare function parseJsonc(text: string): any;
export declare function sectionOf(config: any, env: DeployEnv): any;
export declare function placeholderPaths(obj: unknown, prefix?: string): string[];
export declare function domainOf(section: any): string | null;
export declare function dbNameOf(section: any): string | null;
export declare function configIssues(config: any, env: DeployEnv): { errors: string[]; warnings: string[] };
export declare function stripTsComments(src: string): string;
export declare const LEGAL_MARKERS: string[];
export declare function countLegalMarkers(sources: Record<string, string>): { total: number; byFile: Record<string, number> };
export declare function gitIssues(branch: string | null, porcelain: string | null): string[];
export declare function domainConfirmed(typed: string, domain: string | null): boolean;
export declare function backupFileName(env: DeployEnv, d?: Date): string;
export declare function envArg(raw: unknown): DeployEnv | null;
export declare function envFlags(env: DeployEnv): string[];
