import { defineConfig } from 'tsup';

/* ESM only. This is a browser package — it touches window, the canvas and
   requestAnimationFrame — so a CommonJS build would be ceremony for a consumer
   who cannot exist. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  /* Declarations come from tsc, not from here: tsup generates them with
     rollup-plugin-dts, which does not support TypeScript 7's compiler API.
     `tsc -p tsconfig.build.json` emits the same thing and keeps the package on
     the same TypeScript the rest of the work uses. */
  dts: false,
  clean: true,
  treeshake: true,
  target: 'es2022',
});
