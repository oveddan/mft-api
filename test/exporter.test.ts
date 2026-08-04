import assert from "node:assert/strict";
import test from "node:test";

import { exportConfiguration } from "../src/exporter.js";
import type { DeviceDescriptor } from "../src/model.js";
import type { MessageHandler, MidiConnection } from "../src/midi.js";
import { assertReadOnlyRequest } from "../src/protocol.js";

const GLOBAL_PAIRS = [
  0, 4, 1, 1,
  2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0,
  8, 63, 9, 127,
  31, 127, 32, 100, 33, 1, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1,
];

const ENCODER_PAIRS = [
  10, 1, 11, 0, 12, 0, 13, 2, 14, 12,
  15, 0, 16, 1, 17, 34, 18, 1, 19, 25,
  20, 5, 21, 63, 22, 2, 23, 0, 24, 5,
];

class FakeFourBankTwister implements MidiConnection {
  readonly sent: number[][] = [];
  private readonly handlers = new Set<MessageHandler>();

  constructor(private readonly bankCount: 4 | 8 = 4) {}

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    const bytes = Array.from(message);
    this.sent.push(bytes);
    const command = bytes[4];
    if (command === 0x05) {
      this.emit([0xf0, 0, 1, 0x79, 5, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]);
    } else if (command === 0x02) {
      this.emit([0xf0, 0, 1, 0x79, 2, 1, ...GLOBAL_PAIRS, 0xf7]);
    } else if (command === 0x04) {
      const tag = bytes[6]!;
      if (tag === 65 && this.bankCount === 4) {
        this.emit([0xf0, 0, 1, 0x79, 4, 0, 65, 1, 1, 0, 0xf7]);
      } else {
        this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...ENCODER_PAIRS.slice(0, 24), 0xf7]);
        this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, 6, ...ENCODER_PAIRS.slice(24), 0xf7]);
      }
    }
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
  inputPort: { index: 0, name: "Midi Fighter Twister" },
  outputPort: { index: 0, name: "Midi Fighter Twister" },
  identity: {
    manufacturerId: [0, 1, 0x79],
    familyId: 5,
    modelId: 1,
    firmwareBytes: [0x20, 0x26, 7, 2],
    firmwareDate: "2026-07-02",
  },
};

test("exports all globals, colors, and 64 encoders from a four-bank device", async () => {
  const connection = new FakeFourBankTwister();
  const result = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });

  assert.equal(result.capabilities.bankCount, 4);
  assert.equal(result.banks.length, 4);
  assert.equal(result.banks[3]!.encoders.length, 16);
  assert.deepEqual(result.banks[0]!.encoders[0]!.colors, { active: 25, inactive: 5 });
  assert.equal(result.banks[0]!.encoders[0]!.detent.color, 63);
  assert.equal(result.globals.colorMap.name, "mf64");
  assert.equal(result.globals.sleep.timeoutMinutes, 60);
  assert.equal(result.device.unitId?.hex, "0102030405060708");

  const bulkTags = connection.sent.filter((message) => message[4] === 4).map((message) => message[6]);
  assert.equal(bulkTags[0], 65);
  assert.equal(bulkTags.at(-1), 0);
  assert.equal(bulkTags.length, 65);
});

test("uses tag 64 and normalizes the shifted channel for pre-2026 firmware", async () => {
  const connection = new FakeFourBankTwister();
  const legacyDevice: DeviceDescriptor = {
    ...device,
    identity: {
      ...device.identity,
      firmwareBytes: [0x20, 0x23, 6, 8],
      firmwareDate: "2023-06-08",
    },
  };
  const result = await exportConfiguration(connection, legacyDevice, { timeoutMs: 100, retries: 0 });

  const bulkTags = connection.sent.filter((message) => message[4] === 4).map((message) => message[6]);
  assert.equal(bulkTags[0], 1);
  assert.equal(bulkTags.at(-1), 64);
  assert.equal(bulkTags.length, 64);
  assert.equal(result.banks[0]!.encoders[0]!.encoder.shiftedMidiChannel, 6);
});

test("detects and exports all 128 encoders from an eight-bank device", async () => {
  const connection = new FakeFourBankTwister(8);
  const result = await exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });

  assert.equal(result.capabilities.bankCount, 8);
  assert.equal(result.banks.length, 8);
  assert.equal(result.banks[7]!.encoders.length, 16);
  const bulkTags = connection.sent.filter((message) => message[4] === 4).map((message) => message[6]);
  assert.equal(bulkTags.filter((tag) => tag === 65).length, 2);
  assert.equal(bulkTags.at(-1), 0);
  assert.equal(bulkTags.length, 129);
});
