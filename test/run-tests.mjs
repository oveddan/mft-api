// Runs the test suite on every supported Node version and platform.
//
// `tsx --test test/*.test.ts` cannot do that on its own:
//   - Windows shells do not expand globs, and npm hands the script text to
//     cmd, so tsx receives the literal pattern.
//   - Quoting it only helps on Node 21 and newer, where the test runner
//     learned to expand globs itself. This package supports Node 20.
//
// So enumerate the files here instead, and exit non-zero if there are none —
// otherwise renaming a test file would leave CI green with nothing running.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("test", name));

if (files.length === 0) {
  process.stderr.write("No test files matching *.test.ts were found in test/\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
