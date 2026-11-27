// test/deploy-checks.test.ts 의 형식 검사용 선언 (구현은 deploy-checks.mjs).
export declare const PLACEHOLDER: string;
export declare const ENVS: readonly ['production'];
export declare const REQUIRED_KEYS: string[];
export declare function placeholderKeys(vars: Record<string, string | undefined>): string[];
export declare function configIssues(vars: Record<string, string | undefined>): { errors: string[]; warnings: string[] };
export declare function stripTsComments(src: string): string;
export declare const LEGAL_MARKERS: string[];
export declare function countLegalMarkers(sources: Record<string, string>): { total: number; byFile: Record<string, number> };
export declare function gitIssues(branch: string | null, porcelain: string | null): string[];
export declare function envArg(raw: unknown): 'production' | null;
