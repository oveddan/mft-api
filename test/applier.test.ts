import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatchPlan } from "../src/applier.js";
import { exportConfiguration } from "../src/exporter.js";
import { createPatchPlan } from "../src/planner.js";
import { device, FakeWritableTwister, GLOBALS } from "./fake-twister.js";

test("applies an eligible plan with backup, journal, and full snapshot verification", async () => {
  const connection = new FakeWritableTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [
    { path: "bank.1.encoder.1.colors.active", value: "green" },
    { path: "bank.1.encoder.1.colors.inactive", value: "purple" },
  ]);
  const directory = await mkdtemp(join(tmpdir(), "mft-apply-test-"));
  const journalPath = join(directory, "journal.ndjson");
  const backupPath = join(directory, "backup.json");
  const result = await applyPatchPlan(connection, device, plan, {
    journalPath,
    timeoutMs: 100,
    pacingMs: 0,
    saveBackup: async (snapshot) => {
      await writeFile(backupPath, JSON.stringify(snapshot));
      return backupPath;
    },
  });

  assert.equal(result.postSnapshot.banks[0]!.encoders[0]!.rawTags["19"], 43);
  assert.equal(result.postSnapshot.banks[0]!.encoders[0]!.rawTags["20"], 107);
  assert.equal(JSON.parse(await readFile(backupPath, "utf8")).banks[0].encoders[0].rawTags["19"], 25);
  const journal = await readFile(journalPath, "utf8");
  assert.match(journal, /"outcome":"verified"/);
  assert.match(journal, /"outcome":"complete"/);
});

async function applyColorChange(connection: FakeWritableTwister): Promise<{ before: Awaited<ReturnType<typeof exportConfiguration>>; journalPath: string; apply: () => Promise<unknown> }> {
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);
  const directory = await mkdtemp(join(tmpdir(), "mft-refresh-test-"));
  const journalPath = join(directory, "journal.ndjson");
  return {
    before,
    journalPath,
    apply: () =>
      applyPatchPlan(connection, device, plan, {
        journalPath,
        timeoutMs: 100,
        pacingMs: 0,
        saveBackup: async () => join(directory, "backup.json"),
      }),
  };
}

test("encoder-only writes end with a global frame that leaves globals byte-identical", async () => {
  const connection = new FakeWritableTwister();
  const { before, apply } = await applyColorChange(connection);
  await apply();

  const globalWrites = connection.writes.filter((bytes) => bytes[4] === 1);
  assert.equal(globalWrites.length, 1, "expected exactly one global frame to re-enable the display");
  assert.equal(connection.writes.at(-1)![4], 1, "the display re-enable must be the final frame");

  const after = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  assert.deepEqual(after.globals.rawTags, before.globals.rawTags, "the refresh must not alter any global tag");
});

test("a failed display re-enable is journaled as unknown after the changes verified", async () => {
  const connection = new FakeWritableTwister();
  const { journalPath, apply } = await applyColorChange(connection);
  connection.failNextGlobalWrite();

  await assert.rejects(apply(), /display re-enable write outcome is unknown/);
  const journal = await readFile(journalPath, "utf8");
  assert.match(journal, /"outcome":"unknown".*Display re-enable write failed/);
  assert.doesNotMatch(journal, /"outcome":"complete"/);
});

test("an unsupported global tag layout is refused before any encoder frame is sent", async () => {
  const connection = new FakeWritableTwister(GLOBALS.slice(0, -2));
  const { apply } = await applyColorChange(connection);

  await assert.rejects(apply(), /tag layout is not allowlisted/);
  assert.deepEqual(connection.writes, [], "no frame may be written when the refresh frame cannot be encoded");
});
