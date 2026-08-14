import { firmwarePolicy, type FirmwarePolicy } from "./compatibility.js";
import type { ConfigExport } from "./model.js";
import { sha256, snapshotHash } from "./snapshot.js";
import { encodeEncoderDryRun, encodeGlobalDryRun, type DryRunFrame } from "./write-codec.js";

export interface PatchInput {
  path: string;
  value: string | number | boolean;
  expected?: number | boolean;
}

export interface PlannedChange {
  path: string;
  target: string;
  tag: number;
  expected: number | boolean;
  desired: number | boolean;
  rawExpected: number;
  rawDesired: number;
}

export const PATCH_PLAN_SCHEMA = "djtt.mft.patch-plan.v2";

export interface PatchPlan {
  schemaVersion: typeof PATCH_PLAN_SCHEMA;
  planId: string;
  createdAt: string;
  expiresAt: string;
  snapshotHash: string;
  deviceBinding: {
    unitId: string | null;
    firmwareDate: string;
    familyId: number;
    modelId: number;
    identityStrength: "strong" | "weak";
  };
  applyEligibility: { eligible: boolean; reasons: string[] };
  changes: PlannedChange[];
  frames: DryRunFrame[];
}

type ValueKind = "boolean" | "number" | "color";

interface FieldRule {
  tag: number;
  kind: ValueKind;
  min?: number;
  max?: number;
  shiftedChannel?: boolean;
}

const GLOBAL_FIELDS: Record<string, FieldRule> = {
  midiChannel: { tag: 0, kind: "number", min: 1, max: 16 },
  sideButtonsBanked: { tag: 1, kind: "boolean" },
  "superKnob.start": { tag: 8, kind: "number", min: 0, max: 127 },
  "superKnob.end": { tag: 9, kind: "number", min: 0, max: 127 },
  "brightness.rgb": { tag: 31, kind: "number", min: 0, max: 127 },
  "brightness.indicator": { tag: 32, kind: "number", min: 0, max: 127 },
  "colorMap.code": { tag: 33, kind: "number", min: 0, max: 1 },
  "animationChannels.encoder": { tag: 34, kind: "number", min: 1, max: 16 },
  "animationChannels.switch": { tag: 35, kind: "number", min: 1, max: 16 },
  "sleep.timeoutIndex": { tag: 36, kind: "number", min: 0, max: 7 },
  "sleep.animation.code": { tag: 37, kind: "number", min: 0, max: 1 },
  bankAnimationsEnabled: { tag: 38, kind: "boolean" },
};

const ENCODER_FIELDS: Record<string, FieldRule> = {
  "detent.enabled": { tag: 10, kind: "boolean" },
  "movement.code": { tag: 11, kind: "number", min: 0, max: 2 },
  "switch.action.code": { tag: 12, kind: "number", min: 0, max: 8 },
  "switch.midiChannel": { tag: 13, kind: "number", min: 1, max: 16 },
  "switch.midiNumber": { tag: 14, kind: "number", min: 0, max: 127 },
  "encoder.midiChannel": { tag: 16, kind: "number", min: 1, max: 16 },
  "encoder.midiNumber": { tag: 17, kind: "number", min: 0, max: 127 },
  "encoder.type.code": { tag: 18, kind: "number", min: 0, max: 5 },
  "colors.active": { tag: 19, kind: "color" },
  "colors.inactive": { tag: 20, kind: "color" },
  "detent.color": { tag: 21, kind: "color" },
  "indicator.code": { tag: 22, kind: "number", min: 0, max: 3 },
  superKnobEnabled: { tag: 23, kind: "boolean" },
  "encoder.shiftedMidiChannel": { tag: 24, kind: "number", min: 1, max: 16, shiftedChannel: true },
};

const COLOR_NAMES: Record<"classic" | "mf64", Record<string, number>> = {
  classic: { off: 0, black: 0, blue: 1, green: 43, yellow: 64, red: 85, magenta: 107, purple: 107, white: 127 },
  mf64: { off: 0, black: 0, white: 3, red: 5, orange: 9, yellow: 13, green: 21, teal: 33, blue: 45, purple: 49, magenta: 53, pink: 57 },
};

function parseBoolean(value: PatchInput["value"]): boolean {
  if (value === true || value === false) return value;
  if (value === 1 || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "on") return true;
  if (value === 0 || String(value).toLowerCase() === "false" || String(value).toLowerCase() === "off") return false;
  throw new Error(`Expected a boolean value, received ${String(value)}`);
}

function resolveValue(value: PatchInput["value"], rule: FieldRule, palette: "classic" | "mf64"): number | boolean {
  if (rule.kind === "boolean") return parseBoolean(value);
  let numeric: number;
  if (rule.kind === "color" && typeof value === "string" && !/^\d+$/.test(value)) {
    const resolved = COLOR_NAMES[palette][value.toLowerCase()];
    if (resolved === undefined) throw new Error(`Unknown ${palette} color name ${value}`);
    numeric = resolved;
  } else {
    numeric = typeof value === "number" ? value : Number(value);
  }
  if (!Number.isInteger(numeric) || numeric < (rule.min ?? 0) || numeric > (rule.max ?? 127)) {
    throw new Error(`Value ${String(value)} is outside ${rule.min ?? 0}..${rule.max ?? 127}`);
  }
  return numeric;
}

function semanticRaw(raw: number, rule: FieldRule, shiftedOneBased: boolean): number | boolean {
  if (rule.kind === "boolean") return raw !== 0;
  if (rule.shiftedChannel && !shiftedOneBased) return raw + 1;
  return raw;
}

function desiredRaw(value: number | boolean, rule: FieldRule, shiftedOneBased: boolean): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (rule.shiftedChannel && !shiftedOneBased) return value - 1;
  return value;
}

function parseTarget(config: ConfigExport, path: string): {
  normalizedPath: string;
  target: string;
  rawTags: Record<string, number>;
  rule: FieldRule;
  bank?: number;
  encoder?: number;
} {
  const globalMatch = path.match(/^globals?\.(.+)$/);
  if (globalMatch) {
    const leaf = globalMatch[1]!;
    const rule = GLOBAL_FIELDS[leaf];
    if (!rule) throw new Error(`Unsupported global field ${leaf}`);
    return { normalizedPath: `global.${leaf}`, target: "globals", rawTags: config.globals.rawTags, rule };
  }
  const encoderMatch = path.match(/^banks?\.(\d+)\.encoders?\.(\d+)\.(.+)$/);
  if (!encoderMatch) throw new Error(`Unsupported patch path ${path}`);
  const bank = Number(encoderMatch[1]);
  const encoder = Number(encoderMatch[2]);
  const leaf = encoderMatch[3]!;
  const rule = ENCODER_FIELDS[leaf];
  if (!rule) throw new Error(`Unsupported encoder field ${leaf}`);
  const record = config.banks.find((candidate) => candidate.number === bank)?.encoders.find((candidate) => candidate.number === encoder);
  if (!record) throw new Error(`Bank ${bank}, encoder ${encoder} does not exist in this snapshot`);
  return {
    normalizedPath: `bank.${bank}.encoder.${encoder}.${leaf}`,
    target: `bank.${bank}.encoder.${encoder}`,
    rawTags: record.rawTags,
    rule,
    bank,
    encoder,
  };
}

/**
 * Re-checks an already-resolved value against its field rule.
 *
 * `resolveValue` enforces this while planning, but planning is not a trust
 * boundary — applying is. Without this, a re-signed plan could set a 1..16
 * field to 100: the value is still 7-bit so the codec accepts it, and
 * `expectedSnapshotAfterChanges` expects the same number, so read-back
 * verification agrees too.
 */
function assertWithinRule(value: number | boolean, rule: FieldRule, path: string): void {
  if (rule.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} expects a boolean, received ${String(value)}`);
    return;
  }
  const minimum = rule.min ?? 0;
  const maximum = rule.max ?? 127;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} value ${String(value)} is outside ${minimum}..${maximum}`);
  }
}

function recordForTarget(
  config: ConfigExport,
  target: string,
): { rawTags: Record<string, number>; bank?: number; encoder?: number } {
  if (target === "globals") return { rawTags: config.globals.rawTags };
  const match = target.match(/^bank\.(\d+)\.encoder\.(\d+)$/);
  if (!match) throw new Error(`Invalid plan target ${target}`);
  const bank = Number(match[1]);
  const encoder = Number(match[2]);
  const record = config.banks
    .find((candidate) => candidate.number === bank)
    ?.encoders.find((candidate) => candidate.number === encoder);
  if (!record) throw new Error(`Plan target ${target} is absent from snapshot`);
  return { rawTags: record.rawTags, bank, encoder };
}

/**
 * Builds the exact write frames a set of changes implies, given the snapshot
 * they apply to.
 *
 * Encoder writes are whole-record bulk transfers, so a frame is only derivable
 * together with the fourteen tags the change does not touch. Those live in the
 * snapshot, never in the change list — which is why a plan's frames cannot be
 * checked against its own changes in isolation, and why the applier calls this
 * with the freshly-read device state rather than with anything the plan
 * carries.
 */
export function deriveFrames(config: ConfigExport, changes: PlannedChange[], policy: FirmwarePolicy): DryRunFrame[] {
  const changedRecords = new Map<string, { rawTags: Record<string, number>; bank?: number; encoder?: number }>();
  for (const change of changes) {
    // Derive from `path` and `desired` — the two fields a human actually reads
    // — rather than from `target`, `tag`, and `rawDesired`. Those three are
    // redundant, and trusting them let a plan display an innocuous path while
    // writing a different tag entirely: `global.brightness.rgb` in the change
    // list, tag 3 in the bytes. They are now cross-checked, not obeyed.
    const resolved = parseTarget(config, change.path);
    assertWithinRule(change.desired, resolved.rule, change.path);
    const rawDesired = desiredRaw(change.desired, resolved.rule, policy.shiftedChannelIsOneBased);
    if (
      resolved.target !== change.target ||
      resolved.rule.tag !== change.tag ||
      resolved.normalizedPath !== change.path ||
      rawDesired !== change.rawDesired
    ) {
      throw new Error(
        `Change ${change.path} does not agree with the target it declares (target ${change.target}, tag ${change.tag})`,
      );
    }

    let changed = changedRecords.get(resolved.target);
    if (!changed) {
      const record = recordForTarget(config, resolved.target);
      changed = { rawTags: { ...record.rawTags }, bank: record.bank, encoder: record.encoder };
      changedRecords.set(resolved.target, changed);
    }
    changed.rawTags[String(resolved.rule.tag)] = rawDesired;
  }

  const frames: DryRunFrame[] = [];
  for (const [target, changed] of changedRecords) {
    if (target === "globals") frames.push(...encodeGlobalDryRun(changed.rawTags, policy));
    else frames.push(...encodeEncoderDryRun(changed.bank!, changed.encoder!, config.capabilities.bankCount, policy, changed.rawTags));
  }
  return frames;
}

/**
 * Whether live writes are permitted for the device this snapshot describes.
 *
 * Deliberately a pure function of a snapshot rather than a stored field. The
 * plan carries its answer for reporting, but the applier must recompute it from
 * the device in front of it: the plan's copy is attacker-editable, and the
 * content hash is unkeyed so re-signing an edited plan is trivial.
 */
export function evaluateApplyEligibility(config: ConfigExport): { eligible: boolean; reasons: string[] } {
  const policy = firmwarePolicy(config.device.firmware.date);
  const reasons: string[] = [];
  if (!policy.liveWriteAllowed) reasons.push(`Live writes are not allowlisted for firmware ${policy.firmwareDate}`);
  if (!config.device.unitId?.hex) reasons.push("Snapshot has no strong per-device identity");
  return { eligible: reasons.length === 0, reasons };
}

export function createPatchPlan(config: ConfigExport, inputs: PatchInput[], now = new Date()): PatchPlan {
  if (config.schemaVersion !== "djtt.mft.config-export.v1") throw new Error("Unsupported snapshot schema");
  if (inputs.length === 0) throw new Error("At least one --set operation is required");
  const policy = firmwarePolicy(config.device.firmware.date);
  const palette = config.globals.colorMap.name === "mf64" ? "mf64" : "classic";
  const changes: PlannedChange[] = [];

  for (const input of inputs) {
    const target = parseTarget(config, input.path);
    const rawExpected = target.rawTags[String(target.rule.tag)];
    if (rawExpected === undefined) throw new Error(`${target.normalizedPath} was not reported by this firmware`);
    const expected = semanticRaw(rawExpected, target.rule, policy.shiftedChannelIsOneBased);
    if (input.expected !== undefined && input.expected !== expected) {
      throw new Error(`${target.normalizedPath} expected ${String(input.expected)}, snapshot contains ${String(expected)}`);
    }
    const desired = resolveValue(input.value, target.rule, palette);
    if (desired === expected) throw new Error(`${target.normalizedPath} is already ${String(desired)}`);
    const rawDesired = desiredRaw(desired, target.rule, policy.shiftedChannelIsOneBased);
    changes.push({ path: target.normalizedPath, target: target.target, tag: target.rule.tag, expected, desired, rawExpected, rawDesired });
  }

  const frames = deriveFrames(config, changes, policy);

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const stateHash = snapshotHash(config);
  const deviceBinding = {
    unitId: config.device.unitId?.hex ?? null,
    firmwareDate: config.device.firmware.date,
    familyId: config.device.familyId,
    modelId: config.device.modelId,
    identityStrength: (config.device.unitId ? "strong" : "weak") as "strong" | "weak",
  };
  const applyEligibility = evaluateApplyEligibility(config);
  // applyEligibility is inside the hashed body: outside it, flipping
  // `eligible` to true left planId valid and bypassed the firmware allowlist.
  // Hashing it is not the real defence — the hash is unkeyed, so an editor can
  // recompute it — but leaving a load-bearing field unhashed is indefensible.
  // The defence is the applier recomputing eligibility from the live device.
  const body = { createdAt, expiresAt, snapshotHash: stateHash, deviceBinding, applyEligibility, changes, frames };
  return {
    schemaVersion: PATCH_PLAN_SCHEMA,
    planId: `sha256:${sha256(body)}`,
    ...body,
  };
}

function planBody(plan: PatchPlan): unknown {
  return {
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    snapshotHash: plan.snapshotHash,
    deviceBinding: plan.deviceBinding,
    applyEligibility: plan.applyEligibility,
    changes: plan.changes,
    frames: plan.frames,
  };
}

export function assertValidPlan(plan: PatchPlan, now = new Date()): void {
  if (plan.schemaVersion !== PATCH_PLAN_SCHEMA) throw new Error("Unsupported patch plan schema");
  if (plan.planId !== `sha256:${sha256(planBody(plan))}`) throw new Error("Patch plan content hash is invalid");
  const expiresAt = new Date(plan.expiresAt).getTime();
  // An unparseable date yields NaN, and `NaN <= now` is false — so without this
  // an unparseable expiry read as "not expired" and the plan never aged out.
  if (!Number.isFinite(expiresAt)) throw new Error(`Patch plan has an unreadable expiry ${plan.expiresAt}`);
  if (expiresAt <= now.getTime()) throw new Error(`Patch plan expired at ${plan.expiresAt}`);
  if (!plan.applyEligibility.eligible) throw new Error(`Patch plan is not eligible: ${plan.applyEligibility.reasons.join("; ")}`);
}

export function expectedSnapshotAfterChanges(config: ConfigExport, changes: PlannedChange[]): ConfigExport {
  const expected = structuredClone(config);
  for (const change of changes) {
    let tags: Record<string, number>;
    if (change.target === "globals") {
      tags = expected.globals.rawTags;
    } else {
      const match = change.target.match(/^bank\.(\d+)\.encoder\.(\d+)$/);
      if (!match) throw new Error(`Invalid plan target ${change.target}`);
      const bank = expected.banks.find((candidate) => candidate.number === Number(match[1]));
      const encoder = bank?.encoders.find((candidate) => candidate.number === Number(match[2]));
      if (!encoder) throw new Error(`Plan target ${change.target} is absent from snapshot`);
      tags = encoder.rawTags;
    }
    if (tags[String(change.tag)] !== change.rawExpected) {
      throw new Error(`${change.path} precondition changed from ${change.rawExpected} to ${String(tags[String(change.tag)])}`);
    }
    tags[String(change.tag)] = change.rawDesired;
  }
  return expected;
}
