import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encoderTransferTag, firmwarePolicy } from "../src/compatibility.js";
import type { ConfigExport, EncoderExport } from "../src/model.js";
import { createPatchPlan, planUpdate } from "../src/planner.js";
import { assembleBulkParts, parseBulkPart, parseTagValues } from "../src/protocol.js";
import { snapshotHash } from "../src/snapshot.js";

function encoder(number: number): EncoderExport {
  return {
    number,
    detent: { enabled: false, color: 63 },
    movement: { code: 0, name: "direct" },
    switch: { action: { code: 0, name: "ccHold" }, midiChannel: 2, midiNumber: number - 1 },
    encoder: { midiChannel: 1, shiftedMidiChannel: 5, midiNumber: number - 1, type: { code: 1, name: "cc" } },
    colors: { active: 25, inactive: 5 },
    indicator: { code: 2, name: "blendedBar" },
    superKnobEnabled: false,
    rawTags: { "10": 0, "11": 0, "12": 0, "13": 2, "14": number - 1, "15": 0, "16": 1, "17": number - 1, "18": 1, "19": 25, "20": 5, "21": 63, "22": 2, "23": 0, "24": 5 },
  };
}

function snapshot(firmwareDate = "2026-07-02", withUnitId = true): ConfigExport {
  return {
    schemaVersion: "djtt.mft.config-export.v1",
    capturedAt: "2026-08-03T00:00:00.000Z",
    device: {
      manufacturer: "DJ TechTools",
      manufacturerId: [0, 1, 121],
      familyId: 5,
      modelId: 1,
      firmware: { date: firmwareDate, identityBytes: firmwareDate.startsWith("2026") ? [32, 38, 7, 2] : [32, 35, 6, 8] },
      unitId: withUnitId ? { source: "sysex-0x05", hex: "0102030405060708" } : null,
      midiPorts: { input: "input-a", output: "output-a" },
    },
    capabilities: { bankCount: 4, encodersPerBank: 16 },
    globals: {
      midiChannel: 4,
      sideButtonsBanked: true,
      sideButtons: Array.from({ length: 6 }, (_, index) => ({ number: index + 1, action: { code: 0, name: "ccHold" } })),
      superKnob: { start: 63, end: 127 },
      brightness: { rgb: 127, indicator: 127 },
      colorMap: { code: 1, name: "mf64" },
      animationChannels: { encoder: 6, switch: 3 },
      sleep: { timeoutIndex: 7, timeoutMinutes: 60, animation: { code: 1, name: "rainbowWave" } },
      bankAnimationsEnabled: true,
      rawTags: { "0": 4, "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 63, "9": 127, "31": 127, "32": 127, "33": 1, "34": 6, "35": 3, "36": 7, "37": 1, "38": 1 },
    },
    banks: [{ number: 1, encoders: [encoder(1)] }],
    warnings: [],
  };
}

test("creates a content-addressed color plan and preserves all untouched encoder tags", () => {
  const plan = createPatchPlan(
    snapshot(),
    [
      { path: "bank.1.encoder.1.colors.active", value: "red" },
      { path: "bank.1.encoder.1.colors.inactive", value: "blue" },
    ],
    new Date("2026-08-03T12:00:00.000Z"),
  );

  assert.match(plan.planId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.applyEligibility.eligible, true);
  assert.equal(plan.changes[0]!.rawDesired, 5);
  assert.equal(plan.changes[1]!.rawDesired, 45);
  assert.equal(plan.frames.length, 2);

  const values = parseTagValues(assembleBulkParts(plan.frames.map((item) => parseBulkPart(item.bytes))));
  assert.equal(values.get(19), 5);
  assert.equal(values.get(20), 45);
  assert.equal(values.get(15), 0);
  assert.equal(values.size, 15);
});

test("snapshot hash ignores capture metadata but changes with persistent state", () => {
  const first = snapshot();
  const second = snapshot();
  second.capturedAt = "2026-08-04T00:00:00.000Z";
  second.device.midiPorts.input = "renamed port";
  assert.equal(snapshotHash(first), snapshotHash(second));
  second.banks[0]!.encoders[0]!.rawTags["19"] = 85;
  assert.notEqual(snapshotHash(first), snapshotHash(second));
});

test("legacy plans normalize shifted channels but remain ineligible for live apply", () => {
  const legacy = snapshot("2023-06-08", false);
  legacy.banks[0]!.encoders[0]!.rawTags["24"] = 4;
  const plan = createPatchPlan(legacy, [{ path: "bank.1.encoder.1.encoder.shiftedMidiChannel", value: 6 }]);
  assert.deepEqual({ expected: plan.changes[0]!.expected, desired: plan.changes[0]!.desired, rawDesired: plan.changes[0]!.rawDesired }, { expected: 5, desired: 6, rawDesired: 5 });
  assert.equal(plan.applyEligibility.eligible, false);
  assert.equal(plan.applyEligibility.reasons.length, 2);
});

test("rejects stale expected values, unsupported fields, and future firmware", () => {
  assert.throws(() => createPatchPlan(snapshot(), [{ path: "bank.1.encoder.1.colors.active", value: "red", expected: 99 }]), /snapshot contains 25/);
  assert.throws(() => createPatchPlan(snapshot(), [{ path: "bank.1.encoder.1.notAField", value: 1 }]), /Unsupported encoder field/);
  assert.throws(() => createPatchPlan(snapshot("2027-01-01"), [{ path: "global.brightness.rgb", value: 1 }]), /Unsupported future firmware/);
  const unknownLayout = snapshot();
  unknownLayout.globals.rawTags["39"] = 1;
  assert.throws(() => createPatchPlan(unknownLayout, [{ path: "global.brightness.rgb", value: 100 }]), /tag layout is not allowlisted/);
});

test("compatibility fixtures select the expected last encoder tag", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/profiles.json", import.meta.url), "utf8")) as Array<{ firmwareDate: string; bankCount: 4 | 8; lastTag: number; writeAllowed: boolean }>;
  for (const fixture of fixtures) {
    const policy = firmwarePolicy(fixture.firmwareDate);
    assert.equal(encoderTransferTag(fixture.bankCount, 16, fixture.bankCount, policy), fixture.lastTag);
    assert.equal(policy.liveWriteAllowed, fixture.writeAllowed);
  }
});

test("planUpdate skips values already set instead of aborting the whole update", () => {
  const config = JSON.parse(readFileSync(new URL("fixtures/synthetic-four-bank.json", import.meta.url), "utf8")) as ConfigExport;
  // Encoder 1 is already green in the fixture; encoder 2 is not being changed
  // to its current value. `createPatchPlan` refuses the pair outright.
  assert.throws(
    () => createPatchPlan(config, [
      { path: "bank.1.encoder.1.colors.active", value: "green" },
      { path: "bank.1.encoder.2.colors.active", value: "blue" },
    ]),
    /is already/,
  );

  const { plan, skipped } = planUpdate(config, [
    { path: "bank.1.encoder.1.colors.active", value: "green" },
    { path: "bank.1.encoder.2.colors.active", value: "blue" },
  ]);

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.path, "bank.1.encoder.1.colors.active");
  assert.equal(plan?.changes.length, 1);
  assert.equal(plan?.changes[0]?.path, "bank.1.encoder.2.colors.active");
});

test("planUpdate reports nothing to do when every value is already set", () => {
  const config = JSON.parse(readFileSync(new URL("fixtures/synthetic-four-bank.json", import.meta.url), "utf8")) as ConfigExport;

  const { plan, skipped } = planUpdate(config, [{ path: "bank.1.encoder.1.colors.active", value: "green" }]);

  assert.equal(plan, null, "an all-skipped update must succeed having done nothing");
  assert.equal(skipped.length, 1);
});

test("planUpdate refuses two --set operations for the same field", () => {
  const config = JSON.parse(readFileSync(new URL("fixtures/synthetic-four-bank.json", import.meta.url), "utf8")) as ConfigExport;

  assert.throws(
    () => planUpdate(config, [
      { path: "bank.1.encoder.1.colors.active", value: "blue" },
      { path: "bank.1.encoder.1.colors.active", value: "red" },
    ]),
    /Duplicate --set/,
  );
});
