import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    target: "node20",
    outDir: "dist/cli",
    ssr: true,
    emptyOutDir: false,
    // Small + fast CLI: minified single file, no sourcemaps, no gzip-size
    // reporting (build-only cost).
    minify: "oxc",
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 300,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/cli/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
        banner: "#!/usr/bin/env node",
      },
      external: [
        "fs",
        "path",
        "os",
        "crypto",
        "readline",
        "child_process",
        "events",
        "util",
        "stream",
      ],
    },
  },
});
