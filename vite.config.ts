/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    // Lock-contention and crash-recovery tests block synchronously for ~6 s by
    // design (bounded retry loops); Vitest 5 enforces the timeout on elapsed
    // time even for synchronous blocking, so the 5 s default is too tight.
    testTimeout: 30000,
  },
});
