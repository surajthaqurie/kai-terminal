import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist/cli',
    ssr: true,
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/cli/index.ts'),
      formats: ['es'],
      fileName: () => 'kai.js',
    },
    rollupOptions: {
      external: [
        'fs',
        'path',
        'os',
        'crypto',
        'readline',
        'child_process',
        'events',
        'util',
        'stream',
      ],
    },
  },
});
