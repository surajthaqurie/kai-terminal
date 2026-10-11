#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bundledCliPath = path.resolve(__dirname, '../dist/cli/index.js');

if (!fs.existsSync(bundledCliPath)) {
  console.error('[kai] Error: Compiled CLI bundle not found at ' + bundledCliPath);
  console.error('[kai] Please run "npm run build:cli" before running the binary.');
  process.exit(1);
}

const { runCli } = await import(pathToFileURL(bundledCliPath).href);
const exitCode = await runCli(process.argv);
process.exit(exitCode);
