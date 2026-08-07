export const DJTT_HEADER = [0xf0, 0x00, 0x01, 0x79] as const;
export const UNIVERSAL_IDENTITY_REQUEST = Uint8Array.from([
  0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7,
]);

export const Commands = {
  pullGlobals: 0x02,
  bulkTransfer: 0x04,
  getDeviceId: 0x05,
} as const;

export interface Identity {
  manufacturerId: [number, number, number];
  familyId: number;
  modelId: number;
  firmwareBytes: [number, number, number, number];
  firmwareDate: string;
}

export interface BulkPart {
  tag: number;
  part: number;
  total: number;
  data: number[];
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

export function bytesEqual(actual: ArrayLike<number>, expected: ArrayLike<number>): boolean {
  if (actual.length !== expected.length) return false;
  return Array.from(actual).every((value, index) => value === expected[index]);
}

function assertSysex(message: ArrayLike<number>): number[] {
  const bytes = Array.from(message);
  if (bytes.length < 2 || bytes[0] !== 0xf0 || bytes.at(-1) !== 0xf7) {
    throw new Error("Expected a complete SysEx message");
  }
  for (const byte of bytes.slice(1, -1)) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) {
      throw new Error(`Invalid 7-bit SysEx data byte: ${byte}`);
    }
  }
  return bytes;
}

function assertDjtt(message: ArrayLike<number>, command: number): number[] {
  const bytes = assertSysex(message);
  if (!bytesEqual(bytes.slice(0, 4), DJTT_HEADER) || bytes[4] !== command) {
    throw new Error(`Expected DJ TechTools command 0x${hexByte(command)}`);
  }
  return bytes;
}

function vendorRequest(command: number, payload: number[]): Uint8Array {
  return Uint8Array.from([...DJTT_HEADER, command, ...payload, 0xf7]);
}

export function pullGlobalsRequest(): Uint8Array {
  return vendorRequest(Commands.pullGlobals, [0x00]);
}

export function getDeviceIdRequest(): Uint8Array {
  return vendorRequest(Commands.getDeviceId, [0x00]);
}

export function pullEncoderRequest(tag: number): Uint8Array {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0x7f) {
    throw new Error(`Encoder transfer tag must be 0..127, received ${tag}`);
  }
  return vendorRequest(Commands.bulkTransfer, [0x01, tag]);
}

/** Reject every outbound frame except the three non-mutating protocol requests. */
export function assertReadOnlyRequest(message: ArrayLike<number>): void {
  const bytes = assertSysex(message);
  if (bytesEqual(bytes, UNIVERSAL_IDENTITY_REQUEST)) return;
  if (!bytesEqual(bytes.slice(0, 4), DJTT_HEADER)) {
    throw new Error("Blocked non-DJTT outbound SysEx message");
  }

  const command = bytes[4];
  const payload = bytes.slice(5, -1);
  const allowed =
    (command === Commands.pullGlobals && bytesEqual(payload, [0x00])) ||
    (command === Commands.getDeviceId && bytesEqual(payload, [0x00])) ||
    (command === Commands.bulkTransfer && payload.length === 2 && payload[0] === 0x01);

  if (!allowed) {
    throw new Error(`Blocked mutating or unknown command 0x${hexByte(command ?? -1)}`);
  }
}

/** Permit configuration writes only; system, reset, and arbitrary SysEx remain blocked. */
export function assertConfigurationWrite(message: ArrayLike<number>): void {
  const bytes = assertSysex(message);
  if (!bytesEqual(bytes.slice(0, 4), DJTT_HEADER)) throw new Error("Blocked non-DJTT write message");
  const command = bytes[4];
  if (command === 0x01) {
    if ((bytes.length - 6) % 2 !== 0) throw new Error("Global write has an incomplete tag/value pair");
    return;
  }
  if (command === 0x04 && bytes[5] === 0x00) {
    if (bytes.length < 11 || bytes[7]! < 1 || bytes[8]! < 1 || bytes[9]! > 24 || bytes.length !== 11 + bytes[9]!) {
      throw new Error("Malformed encoder configuration write");
    }
    return;
  }
  throw new Error(`Blocked non-configuration command 0x${hexByte(command ?? -1)}`);
}

export function parseIdentityResponse(message: ArrayLike<number>): Identity {
  const bytes = assertSysex(message);
  if (
    bytes.length !== 17 ||
    bytes[1] !== 0x7e ||
    bytes[3] !== 0x06 ||
    bytes[4] !== 0x02 ||
    !bytesEqual(bytes.slice(5, 8), [0x00, 0x01, 0x79])
  ) {
    throw new Error("Not a MIDI Fighter Twister identity response");
  }

  const familyLsb = bytes[8]!;
  const familyMsb = bytes[9]!;
  const modelLsb = bytes[10]!;
  const modelMsb = bytes[11]!;
  const firmwareBytes = bytes.slice(12, 16) as [number, number, number, number];
  const [yearHigh, yearLow, month, day] = firmwareBytes;
  const familyId = familyLsb | (familyMsb << 7);
  const modelId = modelLsb | (modelMsb << 7);
  if (familyId !== 5 || modelId !== 1) {
    throw new Error(`DJ TechTools device is not a MIDI Fighter Twister (family ${familyId}, model ${modelId})`);
  }

  return {
    manufacturerId: [0x00, 0x01, 0x79],
    familyId,
    modelId,
    firmwareBytes,
    firmwareDate: `${hexByte(yearHigh)}${hexByte(yearLow)}-${hexByte(month)}-${hexByte(day)}`,
  };
}

export function isIdentityResponse(message: ArrayLike<number>): boolean {
  try {
    parseIdentityResponse(message);
    return true;
  } catch {
    return false;
  }
}

export function parseDeviceIdResponse(message: ArrayLike<number>): number[] {
  const bytes = assertDjtt(message, Commands.getDeviceId);
  if (bytes.length !== 15 || bytes[5] !== 0x01) {
    throw new Error("Malformed command 0x05 response");
  }
  return bytes.slice(6, 14);
}

export function parseGlobalResponse(message: ArrayLike<number>): Map<number, number> {
  const bytes = assertDjtt(message, Commands.pullGlobals);
  if (bytes[5] !== 0x01) throw new Error("Global response flag is not 1");
  const data = bytes.slice(6, -1);
  if (data.length % 2 !== 0) throw new Error("Global response has an incomplete tag/value pair");

  const values = new Map<number, number>();
  for (let index = 0; index < data.length; index += 2) {
    values.set(data[index]!, data[index + 1]!);
  }
  return values;
}

export function parseBulkPart(message: ArrayLike<number>): BulkPart {
  const bytes = assertDjtt(message, Commands.bulkTransfer);
  if (bytes.length < 11 || bytes[5] !== 0x00) {
    throw new Error("Malformed bulk-pull response");
  }

  const tag = bytes[6]!;
  const part = bytes[7]!;
  const total = bytes[8]!;
  const size = bytes[9]!;
  if (part < 1 || total < 1 || part > total || size > 24) {
    throw new Error("Invalid bulk transfer metadata");
  }
  if (bytes.length !== 11 + size) {
    throw new Error(`Bulk part declared ${size} data bytes but frame length does not match`);
  }
  return { tag, part, total, data: bytes.slice(10, 10 + size) };
}

export function assembleBulkParts(parts: BulkPart[]): number[] {
  if (parts.length === 0) throw new Error("No bulk parts received");
  const total = parts[0]!.total;
  const tag = parts[0]!.tag;
  if (parts.some((part) => part.total !== total || part.tag !== tag)) {
    throw new Error("Bulk parts do not belong to the same transfer");
  }

  const byNumber = new Map(parts.map((part) => [part.part, part]));
  if (byNumber.size !== total) {
    throw new Error(`Bulk transfer is incomplete: expected ${total} parts, received ${byNumber.size}`);
  }

  const data: number[] = [];
  for (let part = 1; part <= total; part += 1) {
    const current = byNumber.get(part);
    if (!current) throw new Error(`Bulk transfer is missing part ${part}`);
    data.push(...current.data);
  }
  return data;
}

export function parseTagValues(data: number[]): Map<number, number> {
  if (data.length % 2 !== 0) throw new Error("Encoder data has an incomplete tag/value pair");
  const values = new Map<number, number>();
  for (let index = 0; index < data.length; index += 2) {
    values.set(data[index]!, data[index + 1]!);
  }
  return values;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map(hexByte).join("");
}
