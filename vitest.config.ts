import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'istanbul',
      include: ['src/**'],
      /* Generated from the compiled module — a base64 string, with nothing to
         assert that the engine's own tests do not already cover. */
      exclude: ['src/wasm.ts'],
      thresholds: { 100: true },
    },
  },
});
