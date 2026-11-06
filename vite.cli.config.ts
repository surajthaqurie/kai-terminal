import { defineConfig } from "vite";
import path from "path";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Microsoft Entra Application (client) ID to bake into this build, from the
 * environment. Empty when unset (the build then has no built-in app and sign-in asks
 * for one). A value that is set but malformed stops the build: shipping a bad ID would
 * make every user's sign-in fail at Microsoft's page.
 */
function buildClientId(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value && !GUID.test(value)) {
    throw new Error(
      `${name} is not a valid Application (client) ID: expected a GUID, got "${value}".`
    );
  }
  return value;
}

const azureClientId = buildClientId("KAI_BUILD_AZURE_CLIENT_ID");
const teamsClientId = buildClientId("KAI_BUILD_TEAMS_CLIENT_ID");

if (!azureClientId && !teamsClientId) {
  const message =
    "This CLI build has no Microsoft sign-in app ID (KAI_BUILD_AZURE_CLIENT_ID): Azure DevOps and Teams browser sign-in will ask users to supply one.";
  if (process.env.KAI_REQUIRE_SIGNIN_APP === "1") {
    throw new Error(message);
  }
  console.warn(`[kai build] ${message}`);
}

export default defineConfig({
  define: {
    __KAI_BUILD_AZURE_CLIENT_ID__: JSON.stringify(azureClientId),
    __KAI_BUILD_TEAMS_CLIENT_ID__: JSON.stringify(teamsClientId),
  },
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
