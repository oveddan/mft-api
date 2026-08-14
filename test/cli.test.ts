import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The apply gate is a safety control with no other coverage, and the kind of
// thing that silently stops working. Drive the real CLI rather than a unit,
// since what matters is that the shipped entry point refuses.
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, MFT_UNSAFE_APPLY: "", ...env },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test("apply refuses while the issue 14 write-path defects are open", () => {
  const result = runCli(["apply", "--plan", "nonexistent-plan.json", "--yes"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /apply is disabled/);
  assert.match(result.stderr, /issues\/14/);
  // It must refuse on the gate, not incidentally because the plan file is
  // missing — otherwise a real plan file would sail straight through.
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("the gate fires before any MIDI port is opened", () => {
  // A device index far past any real port count: reaching discovery at all
  // would surface a device error instead of the gate message.
  const result = runCli(["apply", "--plan", "nonexistent-plan.json", "--yes", "--device", "99"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /apply is disabled/);
  assert.doesNotMatch(result.stderr, /does not exist|No MIDI Fighter Twister/);
});

test("help still documents apply as disabled", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /apply is the only command that writes settings, and it is disabled/);
});

test("plan still works while apply is gated", () => {
  // Run a real plan to completion. Asserting on a `plan` invocation that fails
  // during argument parsing would pass no matter what the gate did.
  // `plan` never opens a MIDI port, so this stays hermetic.
  const snapshot = fileURLToPath(new URL("fixtures/synthetic-four-bank.json", import.meta.url));
  const result = runCli(["plan", "--snapshot", snapshot, "--set", "bank.1.encoder.1.colors.active=blue"]);

  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout) as { planId: string; changes: unknown[] };
  assert.match(plan.planId, /^sha256:/);
  assert.equal(plan.changes.length, 1);
});
