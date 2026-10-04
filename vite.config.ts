/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5174,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) only accepts the function form; the object form
        // fails with "manualChunks is not a function". Three.js gets its own
        // chunk so the game code can be re-downloaded without it.
        manualChunks: (id: string): string | undefined =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // The match / perf specs simulate tens of seconds of game time (thousands of
    // 128 Hz ticks), which takes more than vitest's 5 s default on a busy
    // machine. 120 s keeps `pnpm test` green without a CLI flag; the numbers
    // that matter are asserted as gameplay behaviour, never as wall-clock time.
    testTimeout: 120_000,
  },
});
