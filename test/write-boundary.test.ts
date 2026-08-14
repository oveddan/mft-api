import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPatchPlan } from "../src/applier.js";
import { exportConfiguration } from "../src/exporter.js";
import type { ConfigurationWriteConnection, MessageHandler } from "../src/midi.js";
import type { DeviceDescriptor } from "../src/model.js";
import { assertValidPlan, createPatchPlan, type PatchPlan, type PlannedChange } from "../src/planner.js";
import { encodeGlobalDryRun } from "../src/write-codec.js";
import { firmwarePolicy } from "../src/compatibility.js";
import type { ConfigExport } from "../src/model.js";
import { assertConfigurationWrite, assertReadOnlyRequest } from "../src/protocol.js";
import { sha256 } from "../src/snapshot.js";

// Regression tests for the apply-boundary defects in issue #14. Each one is a
// path that previously reached the device.

const GLOBALS = [0, 4, 1, 1, 2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0, 8, 63, 9, 127, 31, 127, 32, 127, 33, 0, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1];
const LEGACY_GLOBALS = [0, 4, 1, 1, 2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0, 8, 63, 9, 127, 31, 127, 32, 127];
const BASE_ENCODER = [10, 0, 11, 0, 12, 1, 13, 2, 14, 0, 15, 0, 16, 1, 17, 0, 18, 1, 19, 25, 20, 5, 21, 63, 22, 2, 23, 0, 24, 5];

function merge(stored: number[], incoming: number[]): number[] {
  const current = new Map<number, number>();
  for (let index = 0; index < stored.length; index += 2) current.set(stored[index]!, stored[index + 1]!);
  for (let index = 0; index < incoming.length; index += 2) current.set(incoming[index]!, incoming[index + 1]!);
  return [...current.entries()].sort(([a], [b]) => a - b).flatMap(([tag, value]) => [tag, value]);
}

class FakeTwister implements ConfigurationWriteConnection {
  readonly writes: number[][] = [];
  private readonly handlers = new Set<MessageHandler>();
  private readonly encoders = new Map<number, number[]>();

  private globals: number[];

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

  // Writes have to mutate the fake's state, not just be recorded: the applier
  // reads the device back and compares hashes, so a write-only fake would fail
  // verification and mask whether a guard or the round trip rejected the plan.
  sendConfigurationWrite(message: ArrayLike<number>): void {
    assertConfigurationWrite(message);
    const bytes = Array.from(message);
    this.writes.push(bytes);
    if (bytes[4] === 1) {
      this.globals = merge(this.globals, bytes.slice(5, -1));
      return;
    }
    const ordinal = bytes[6] === 0 ? 64 : bytes[6]!;
    const size = bytes[9]!;
    this.encoders.set(ordinal, merge(this.encoders.get(ordinal)!, bytes.slice(10, 10 + size)));
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

const legacyDevice: DeviceDescriptor = {
  ...device,
  identity: { ...device.identity, firmwareBytes: [32, 23, 6, 8], firmwareDate: "2023-06-08" },
};

// The plan hash is unkeyed, so anyone editing a plan can recompute it. Tests
// that only tamper without re-signing would prove far less than they appear to.
function resign(plan: PatchPlan): PatchPlan {
  const { schemaVersion: _schema, planId: _id, ...body } = plan;
  return { ...plan, planId: `sha256:${sha256(body)}` };
}

// Builds the global frame a forged change list implies, bypassing deriveFrames
// so the test can present a *self-consistent* plan. Otherwise the guard could
// reject it on a frame mismatch and the test would never exercise the change
// check it is actually about.
function globalFramesFor(snapshot: ConfigExport, changes: PlannedChange[]) {
  const rawTags = { ...snapshot.globals.rawTags };
  for (const change of changes) rawTags[String(change.tag)] = change.rawDesired;
  return encodeGlobalDryRun(rawTags, firmwarePolicy(snapshot.device.firmware.date));
}

async function applyTo(connection: ConfigurationWriteConnection, target: DeviceDescriptor, plan: PatchPlan): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mft-boundary-"));
  await applyPatchPlan(connection, target, plan, {
    journalPath: join(directory, "journal.ndjson"),
    timeoutMs: 100,
    pacingMs: 0,
    saveBackup: async () => join(directory, "backup.json"),
  });
}

test("0a: flipping applyEligibility now breaks the content hash", async () => {
  // Legacy firmware, so the plan is genuinely ineligible and flipping the flag
  // is a real edit. On an already-eligible plan the same assignment is a no-op
  // and would pass for no reason.
  const connection = new FakeTwister(LEGACY_GLOBALS);
  const before = await exportConfiguration(connection, legacyDevice, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: 43 }]);
  assert.equal(plan.applyEligibility.eligible, false);

  // Edit the field without re-signing, as a plain text edit of the file would.
  const forged: PatchPlan = { ...plan, applyEligibility: { eligible: true, reasons: [] } };

  assert.throws(() => assertValidPlan(forged), /content hash is invalid/);
});

test("0a: a re-signed forged plan is still refused by the live device check", async () => {
  // Legacy firmware: live writes are not allowlisted, so planning marks the
  // plan ineligible. Forge the flag and re-sign, which defeats every check that
  // reads only the plan file.
  const connection = new FakeTwister(LEGACY_GLOBALS);
  const before = await exportConfiguration(connection, legacyDevice, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: 43 }]);
  assert.equal(plan.applyEligibility.eligible, false);

  const forged = resign({ ...plan, applyEligibility: { eligible: true, reasons: [] } });
  assert.doesNotThrow(() => assertValidPlan(forged), "the re-signed plan must pass file-only validation");

  await assert.rejects(applyTo(connection, legacyDevice, forged), /not eligible for live writes/);
  assert.equal(connection.writes.length, 0, "no bytes may reach a device on non-allowlisted firmware");
});

test("0b: frames that do not match the declared changes are refused", async () => {
  const connection = new FakeTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);

  // Declare a colour change, but ship the bytes of a different one. An encoder
  // frame carries the whole 15-tag record, so this rewrites tags the plan never
  // mentions — exactly what a reviewer reading `changes` would not catch.
  const smuggled = createPatchPlan(before, [{ path: "bank.1.encoder.1.encoder.midiNumber", value: 99 }]);
  const forged = resign({ ...plan, frames: smuggled.frames });

  assert.doesNotThrow(() => assertValidPlan(forged));
  await assert.rejects(applyTo(connection, device, forged), /frames do not match/);
  assert.equal(connection.writes.length, 0);
});

test("0b: a change cannot write a different tag than its path names", async () => {
  const connection = new FakeTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "global.brightness.rgb", value: 100 }]);

  // Keep the path a reviewer reads, retarget the tag the bytes touch. Tags 2-7
  // are real globals that no supported path can reach, so this writes a setting
  // the plan does not admit to touching. The frames still match the changes —
  // it is the changes themselves that lie.
  const retargeted = [{ ...plan.changes[0]!, tag: 3, rawExpected: before.globals.rawTags["3"]!, rawDesired: 77 }];
  const forged = resign({ ...plan, changes: retargeted, frames: globalFramesFor(before, retargeted) });

  await assert.rejects(applyTo(connection, device, forged), /does not agree with the target it declares/);
  assert.equal(connection.writes.length, 0);
});

test("0b: frames whose bytes differ from their hex are refused", async () => {
  const connection = new FakeTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);

  // `hex` is only a rendering. Leave it legitimate so the plan reads correctly,
  // and modify the bytes that actually get sent.
  const tampered = plan.frames.map((frame) => ({ ...frame, bytes: [...frame.bytes] }));
  tampered[0]!.bytes[11] = 0x7f;
  const forged = resign({ ...plan, frames: tampered });

  await assert.rejects(applyTo(connection, device, forged), /frames do not match/);
  assert.equal(connection.writes.length, 0);
});

test("0f: an unreadable expiry is rejected rather than treated as unexpired", async () => {
  const connection = new FakeTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);

  // new Date("never").getTime() is NaN, and `NaN <= now` is false, so this
  // previously sailed through the expiry check and never aged out.
  const forged = resign({ ...plan, expiresAt: "never" });

  assert.throws(() => assertValidPlan(forged), /unreadable expiry/);
});

test("an untampered plan still applies", async () => {
  const connection = new FakeTwister();
  const before = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
  const plan = createPatchPlan(before, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);

  await applyTo(connection, device, plan);

  assert.ok(connection.writes.length > 0, "the guards must not block legitimate applies");
});
