import { defineConfig } from 'tsup';

/* ESM only. This is a browser package — it touches window, the canvas and
   requestAnimationFrame — so a CommonJS build would be ceremony for a consumer
   who cannot exist. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
});
