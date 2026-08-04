import { encoderTransferTag, type FirmwarePolicy } from "./compatibility.js";
import { DJTT_HEADER } from "./protocol.js";

export interface DryRunFrame {
  target: string;
  command: "push-globals" | "push-encoder";
  bytes: number[];
  hex: string;
}

function frame(bytes: number[]): number[] {
  for (const byte of bytes.slice(1, -1)) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) {
      throw new Error(`Cannot encode non-7-bit SysEx value ${byte}`);
    }
  }
  return bytes;
}

function hex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function sortedPairs(rawTags: Record<string, number>): number[] {
  return Object.entries(rawTags)
    .map(([tag, value]) => [Number(tag), value] as const)
    .sort(([left], [right]) => left - right)
    .flatMap(([tag, value]) => [tag, value]);
}

function assertExactTags(rawTags: Record<string, number>, allowed: number[], context: string): void {
  const actual = Object.keys(rawTags).map(Number).sort((left, right) => left - right);
  const expected = [...allowed].sort((left, right) => left - right);
  if (actual.length !== expected.length || actual.some((tag, index) => tag !== expected[index])) {
    throw new Error(`${context} tag layout is not allowlisted: received [${actual.join(", ")}]`);
  }
}

export function encodeGlobalDryRun(rawTags: Record<string, number>, policy: FirmwarePolicy): DryRunFrame[] {
  const allowed = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 31, 32];
  if (policy.profile === "2026-07-02") allowed.push(33, 34, 35, 36, 37, 38);
  assertExactTags(rawTags, allowed, "Global record");
  const bytes = frame([...DJTT_HEADER, 0x01, ...sortedPairs(rawTags), 0xf7]);
  return [{ target: "globals", command: "push-globals", bytes, hex: hex(bytes) }];
}

export function encodeEncoderDryRun(
  bank: number,
  encoder: number,
  bankCount: 4 | 8,
  policy: FirmwarePolicy,
  rawTags: Record<string, number>,
): DryRunFrame[] {
  assertExactTags(rawTags, Array.from({ length: 15 }, (_, index) => index + 10), "Encoder record");
  const tag = encoderTransferTag(bank, encoder, bankCount, policy);
  const data = sortedPairs(rawTags);
  const total = Math.ceil(data.length / 24);
  const frames: DryRunFrame[] = [];
  for (let part = 1; part <= total; part += 1) {
    const payload = data.slice((part - 1) * 24, part * 24);
    const bytes = frame([...DJTT_HEADER, 0x04, 0x00, tag, part, total, payload.length, ...payload, 0xf7]);
    frames.push({
      target: `bank.${bank}.encoder.${encoder}`,
      command: "push-encoder",
      bytes,
      hex: hex(bytes),
    });
  }
  return frames;
}
