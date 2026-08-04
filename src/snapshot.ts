import { createHash } from "node:crypto";

import type { ConfigExport } from "./model.js";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Hash only persistent configuration and stable identity, not capture time or port names. */
export function snapshotState(config: ConfigExport): unknown {
  return {
    device: {
      manufacturerId: config.device.manufacturerId,
      familyId: config.device.familyId,
      modelId: config.device.modelId,
      firmwareDate: config.device.firmware.date,
      unitId: config.device.unitId?.hex ?? null,
    },
    capabilities: config.capabilities,
    globals: config.globals.rawTags,
    banks: config.banks.map((bank) => ({
      number: bank.number,
      encoders: bank.encoders.map((encoder) => ({ number: encoder.number, rawTags: encoder.rawTags })),
    })),
  };
}

export function snapshotHash(config: ConfigExport): string {
  return sha256(snapshotState(config));
}
