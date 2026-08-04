import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleBulkParts,
  assertConfigurationWrite,
  assertReadOnlyRequest,
  getDeviceIdRequest,
  parseBulkPart,
  parseDeviceIdResponse,
  parseGlobalResponse,
  parseIdentityResponse,
  pullEncoderRequest,
  pullGlobalsRequest,
  UNIVERSAL_IDENTITY_REQUEST,
} from "../src/protocol.js";

test("parses the 2026 Twister universal identity response", () => {
  const identity = parseIdentityResponse([
    0xf0, 0x7e, 0x7f, 0x06, 0x02,
    0x00, 0x01, 0x79,
    0x05, 0x00,
    0x01, 0x00,
    0x20, 0x26, 0x07, 0x02,
    0xf7,
  ]);
  assert.equal(identity.familyId, 5);
  assert.equal(identity.modelId, 1);
  assert.equal(identity.firmwareDate, "2026-07-02");
});

test("constructs and permits only read-only outbound commands", () => {
  for (const request of [
    UNIVERSAL_IDENTITY_REQUEST,
    pullGlobalsRequest(),
    getDeviceIdRequest(),
    pullEncoderRequest(0),
    pullEncoderRequest(65),
  ]) {
    assert.doesNotThrow(() => assertReadOnlyRequest(request));
  }

  assert.throws(
    () => assertReadOnlyRequest([0xf0, 0x00, 0x01, 0x79, 0x01, 0x00, 0xf7]),
    /Blocked mutating/,
  );
  assert.throws(
    () => assertReadOnlyRequest([0xf0, 0x00, 0x01, 0x79, 0x03, 0x02, 0xf7]),
    /Blocked mutating/,
  );
  assert.throws(
    () => assertReadOnlyRequest([0xf0, 0x00, 0x01, 0x79, 0x04, 0x00, 0x01, 0xf7]),
    /Blocked mutating/,
  );
});

test("write guard permits only configuration pushes", () => {
  assert.doesNotThrow(() => assertConfigurationWrite([0xf0, 0, 1, 0x79, 1, 0, 4, 31, 127, 0xf7]));
  assert.doesNotThrow(() => assertConfigurationWrite([0xf0, 0, 1, 0x79, 4, 0, 1, 1, 1, 2, 19, 43, 0xf7]));
  assert.throws(() => assertConfigurationWrite([0xf0, 0, 1, 0x79, 3, 2, 0xf7]), /Blocked non-configuration/);
  assert.throws(() => assertConfigurationWrite([0xf0, 0, 1, 0x79, 4, 1, 1, 0xf7]), /Blocked non-configuration/);
});

test("parses command 0x05 and expanded global settings", () => {
  assert.deepEqual(
    parseDeviceIdResponse([
      0xf0, 0x00, 0x01, 0x79, 0x05, 0x01,
      1, 2, 3, 4, 5, 6, 7, 8,
      0xf7,
    ]),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  const globals = parseGlobalResponse([
    0xf0, 0x00, 0x01, 0x79, 0x02, 0x01,
    0, 4, 31, 127, 32, 100, 33, 1, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1,
    0xf7,
  ]);
  assert.equal(globals.get(33), 1);
  assert.equal(globals.get(34), 6);
  assert.equal(globals.get(38), 1);
});

test("reassembles the firmware's 24-byte and 6-byte encoder parts", () => {
  const data = Array.from({ length: 30 }, (_, index) => index + 10);
  const first = parseBulkPart([
    0xf0, 0x00, 0x01, 0x79, 0x04, 0x00, 0x01, 0x01, 0x02, 24,
    ...data.slice(0, 24),
    0xf7,
  ]);
  const second = parseBulkPart([
    0xf0, 0x00, 0x01, 0x79, 0x04, 0x00, 0x01, 0x02, 0x02, 6,
    ...data.slice(24),
    0xf7,
  ]);
  assert.deepEqual(assembleBulkParts([second, first]), data);
});

test("rejects unencoded high-bit data in command 0x05", () => {
  assert.throws(
    () =>
      parseDeviceIdResponse([
        0xf0, 0x00, 0x01, 0x79, 0x05, 0x01,
        1, 2, 3, 4, 5, 6, 7, 0x80,
        0xf7,
      ]),
    /Invalid 7-bit SysEx/,
  );
});
