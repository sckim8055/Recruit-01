// 서버 빌드 (T-19).  npm run build  →  dist/server.mjs (서버) · dist/maint.mjs (npm run maint) — Node 22+ ESM. node_modules 의 패키지(hono·pg 등)는 묶지 않고 그대로 불러온다.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: ROOT,
  entryPoints: { server: 'src/server.ts', maint: 'src/maint-cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('[OK] dist/server.mjs, dist/maint.mjs');
