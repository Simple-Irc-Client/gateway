import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: './dist/gateway.js',
  external: ['iconv-lite'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  define: {
    __PRODUCTION__: 'true',
  },
});

console.log('Build complete: dist/gateway.js');
