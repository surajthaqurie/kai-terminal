import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";

/**
 * Every test file gets its own throwaway KAI_HOME. Without this, tests that
 * register temp projects wrote them into the developer's real ~/.kai, which
 * piled up thousands of dead project graphs there. Tests that set KAI_HOME
 * themselves still override (and restore back to) this one.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-home-"));
process.env.KAI_HOME = home;

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // A file still held open on Windows; the OS temp cleaner takes it.
  }
});
