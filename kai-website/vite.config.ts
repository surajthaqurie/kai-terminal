import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Absolute base so client-side deep routes (e.g. /download, /changelog)
  // resolve bundled assets from the site root. Relative './' breaks on
  // nested paths (browser requests /download/assets/... which 404s).
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
