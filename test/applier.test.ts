import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatchPlan } from "../src/applier.js";
import { exportConfiguration } from "../src/exporter.js";
import type { DeviceDescriptor } from "../src/model.js";
import type { ConfigurationWriteConnection, MessageHandler } from "../src/midi.js";
import { createPatchPlan } from "../src/planner.js";
import { assertConfigurationWrite, assertReadOnlyRequest } from "../src/protocol.js";

const GLOBALS = [0, 4, 1, 1, 2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0, 8, 63, 9, 127, 31, 127, 32, 127, 33, 0, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1];
const BASE_ENCODER = [10, 0, 11, 0, 12, 1, 13, 2, 14, 0, 15, 0, 16, 1, 17, 0, 18, 1, 19, 25, 20, 5, 21, 63, 22, 2, 23, 0, 24, 5];

class FakeWritableTwister implements ConfigurationWriteConnection {
  readonly writes: number[][] = [];
  private readonly handlers = new Set<MessageHandler>();
  private readonly encoders = new Map<number, number[]>();
  private globals: number[];
  private failGlobalWrite = false;

  failNextGlobalWrite(): void {
    this.failGlobalWrite = true;
  }

  constructor(globals: number[] = GLOBALS) {
    this.globals = [...globals];
    for (let tag = 1; tag <= 64; tag += 1) this.encoders.set(tag, [...BASE_ENCODER]);
  }

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    const bytes = Array.from(message);
    if (bytes[4] === 5) this.emit([0xf0, 0, 1, 0x79, 5, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]);
    if (bytes[4] === 2) this.emit([0xf0, 0, 1, 0x79, 2, 1, ...this.globals, 0xf7]);
    if (bytes[4] === 4) {
      const requested = bytes[6]!;
      if (requested === 65) {
        this.emit([0xf0, 0, 1, 0x79, 4, 0, 65, 1, 1, 0, 0xf7]);
        return;
      }
      const ordinal = requested === 0 ? 64 : requested;
      const data = this.encoders.get(ordinal)!;
      this.emit([0xf0, 0, 1, 0x79, 4, 0, requested, 1, 2, 24, ...data.slice(0, 24), 0xf7]);
      this.emit([0xf0, 0, 1, 0x79, 4, 0, requested, 2, 2, 6, ...data.slice(24), 0xf7]);
    }
  }

  sendConfigurationWrite(message: ArrayLike<number>): void {
    assertConfigurationWrite(message);
    const bytes = Array.from(message);
    this.writes.push(bytes);
    if (bytes[4] === 1) {
      if (this.failGlobalWrite) {
        this.failGlobalWrite = false;
        throw new Error("simulated transport failure");
      }
      const current = new Map<number, number>();
      for (let index = 0; index < this.globals.length; index += 2) current.set(this.globals[index]!, this.globals[index + 1]!);
      const data = bytes.slice(5, -1);
      for (let index = 0; index < data.length; index += 2) current.set(data[index]!, data[index + 1]!);
      this.globals = [...current.entries()].sort(([a], [b]) => a - b).flatMap(([tag, value]) => [tag, value]);
      return;
    }
    if (bytes[4] !== 4) throw new Error("Test only supports global and encoder writes");
    const ordinal = bytes[6] === 0 ? 64 : bytes[6]!;
    const current = new Map<number, number>();
    const stored = this.encoders.get(ordinal)!;
    for (let index = 0; index < stored.length; index += 2) current.set(stored[index]!, stored[index + 1]!);
    const size = bytes[9]!;
    const data = bytes.slice(10, 10 + size);
    for (let index = 0; index < data.length; index += 2) current.set(data[index]!, data[index + 1]!);
    this.encoders.set(ordinal, [...current.entries()].sort(([a], [b]) => a - b).flatMap(([tag, value]) => [tag, value]));
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {}

  private emit(message: number[]): void {
    for (const handler of [...this.handlers]) handler(message);
  }
}

const device: DeviceDescriptor = {
  inputPort: { index: 0, name: "Twister" },
  outputPort: { index: 0, name: "Twister" },
  identity: { manufacturerId: [0, 1, 121], familyId: 5, modelId: 1, firmwareBytes: [32, 38, 7, 2], firmwareDate: "2026-07-02" },
};

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
