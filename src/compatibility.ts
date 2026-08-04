export interface FirmwarePolicy {
  profile: "legacy" | "2026-07-02";
  firmwareDate: string;
  shiftedChannelIsOneBased: boolean;
  lastEncoderUsesZeroTag: boolean;
  liveWriteAllowed: boolean;
}

/**
 * Read/plan compatibility is broader than live-write compatibility. Live writes
 * remain allowlisted to the one audited 2026 release and are not yet exposed.
 */
export function firmwarePolicy(firmwareDate: string): FirmwarePolicy {
  if (firmwareDate === "2026-07-02") {
    return {
      profile: "2026-07-02",
      firmwareDate,
      shiftedChannelIsOneBased: true,
      lastEncoderUsesZeroTag: true,
      liveWriteAllowed: true,
    };
  }
  if (firmwareDate < "2026-07-02") {
    return {
      profile: "legacy",
      firmwareDate,
      shiftedChannelIsOneBased: false,
      lastEncoderUsesZeroTag: false,
      liveWriteAllowed: false,
    };
  }
  throw new Error(`Unsupported future firmware ${firmwareDate}; update the compatibility allowlist first`);
}

export function encoderTransferTag(
  bank: number,
  encoder: number,
  bankCount: 4 | 8,
  policy: FirmwarePolicy,
): number {
  if (bank < 1 || bank > bankCount || encoder < 1 || encoder > 16) {
    throw new Error(`Encoder address bank ${bank}, encoder ${encoder} is out of range`);
  }
  const ordinal = (bank - 1) * 16 + encoder;
  return ordinal === bankCount * 16 && policy.lastEncoderUsesZeroTag ? 0 : ordinal;
}
