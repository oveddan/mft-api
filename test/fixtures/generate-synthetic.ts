// Regenerates test/fixtures/synthetic-four-bank.json:
//
//   npx tsx test/fixtures/generate-synthetic.ts
//
// The fixture is fully synthetic on purpose. A real export carries the unit ID
// and the operator's complete knob mapping, which the README and the skill both
// treat as private device data, so none of it belongs in the repository.
//
// Every record is built from deterministic raw tag values and then passed
// through the shipped normalizers, so the raw and normalized halves of the
// fixture cannot drift apart. Do not hand-edit the JSON.

import { writeFileSync } from "node:fs";

import { normalizeEncoder, normalizeGlobals, rawTags, type ConfigExport } from "../../src/model.js";

const firmwareDate = "2026-07-02";
const warnings: string[] = [];

const globalValues = new Map<number, number>([
  [0, 1], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0],
  [8, 0], [9, 127], [31, 127], [32, 127],
  [33, 0], [34, 1], [35, 1], [36, 0], [37, 0], [38, 1],
]);

// Distinct MIDI numbers per encoder keep the fixture useful for planning
// against a specific knob; every other field stays at a neutral default.
function encoderValues(index: number): Map<number, number> {
  return new Map<number, number>([
    [10, 0], // detent.enabled
    [11, 0], // movement
    [12, 0], // switch.action
    [13, 1], // switch.midiChannel
    [14, index % 128], // switch.midiNumber
    [15, 0], // deprecated; the normalizer warns on any other value
    [16, 1], // encoder.midiChannel
    [17, index % 128], // encoder.midiNumber
    [18, 0], // encoder.type
    [19, 43], // colors.active — green in the classic palette
    [20, 0], // colors.inactive
    [21, 64], // detent.color
    [22, 0], // indicator
    [23, 0], // superKnobEnabled
    [24, 1], // encoder.shiftedMidiChannel
  ]);
}

let counter = 0;
const banks = [1, 2, 3, 4].map((number) => ({
  number,
  encoders: Array.from({ length: 16 }, (_, slot) => {
    const values = encoderValues(counter);
    counter += 1;
    return { ...normalizeEncoder(values, slot + 1, firmwareDate, warnings), rawTags: rawTags(values) };
  }),
}));

// Deliberately not cast with `as ConfigExport`: the annotation is what catches
// a missing field such as `capabilities`, which a cast would silently allow
// through into a fixture that then fails only at CLI runtime.
const config: ConfigExport = {
  schemaVersion: "djtt.mft.config-export.v1",
  capturedAt: "2026-01-01T00:00:00.000Z",
  device: {
    manufacturer: "DJ TechTools",
    manufacturerId: [0, 1, 121],
    familyId: 5,
    modelId: 1,
    firmware: { date: firmwareDate, identityBytes: [32, 38, 7, 2] },
    // An all-zero identifier is obviously not a real unit, while still being a
    // strong identity so plans built from this fixture are apply-eligible.
    unitId: { source: "sysex-0x05", hex: "0000000000000000" },
    midiPorts: { input: "Synthetic Twister", output: "Synthetic Twister" },
  },
  capabilities: { bankCount: 4, encodersPerBank: 16 },
  globals: { ...normalizeGlobals(globalValues, warnings), rawTags: rawTags(globalValues) },
  banks,
  warnings,
};

writeFileSync(new URL("synthetic-four-bank.json", import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(`Wrote synthetic-four-bank.json: ${banks.length} banks, ${counter} encoders, ${warnings.length} warnings\n`);
