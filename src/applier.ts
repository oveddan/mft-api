import type { DeviceDescriptor, ConfigExport } from "./model.js";
import type { ConfigurationWriteConnection } from "./midi.js";
import { exportConfiguration } from "./exporter.js";
import { appendJournal } from "./journal.js";
import { assertValidPlan, expectedSnapshotAfterChanges, type PatchPlan } from "./planner.js";
import { snapshotHash } from "./snapshot.js";
import { encodeGlobalDryRun } from "./write-codec.js";
import { firmwarePolicy } from "./compatibility.js";

interface ApplyOptions {
  journalPath: string;
  saveBackup(snapshot: ConfigExport): Promise<string>;
  timeoutMs?: number;
  pacingMs?: number;
}

export interface ApplyResult {
  backupPath: string;
  postSnapshot: ConfigExport;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertDeviceBinding(snapshot: ConfigExport, plan: PatchPlan): void {
  const binding = plan.deviceBinding;
  if (
    snapshot.device.unitId?.hex !== binding.unitId ||
    snapshot.device.firmware.date !== binding.firmwareDate ||
    snapshot.device.familyId !== binding.familyId ||
    snapshot.device.modelId !== binding.modelId
  ) {
    throw new Error("Connected device does not match the patch plan binding");
  }
}

export async function applyPatchPlan(
  connection: ConfigurationWriteConnection,
  device: DeviceDescriptor,
  plan: PatchPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  assertValidPlan(plan);
  const timeoutMs = options.timeoutMs ?? 1000;
  const pacingMs = options.pacingMs ?? 50;
  const before = await exportConfiguration(connection, device, { timeoutMs, retries: 1 });
  assertDeviceBinding(before, plan);
  if (snapshotHash(before) !== plan.snapshotHash) throw new Error("Device configuration changed since this plan was created");
  const backupPath = await options.saveBackup(before);
  await appendJournal(options.journalPath, { planId: plan.planId, outcome: "started", detail: `backup=${backupPath}` });

  const targets = [...new Set(plan.frames.map((frame) => frame.target))];
  const policy = firmwarePolicy(device.identity.firmwareDate);
  // Encoder writes need a trailing global-settings write to re-enable the display
  // (see below). Validate that frame's tag layout before the first write lands, so
  // an unsupported global layout is refused while the device is still untouched
  // instead of after encoder frames have already been applied and verified.
  const needsDisplayRefresh = targets.some((target) => target !== "globals");
  if (needsDisplayRefresh) encodeGlobalDryRun(before.globals.rawTags, policy);
  let progressive = before;
  for (const target of targets) {
    const frames = plan.frames.filter((frame) => frame.target === target);
    const targetChanges = plan.changes.filter((change) => change.target === target);
    const expected = expectedSnapshotAfterChanges(progressive, targetChanges);
    try {
      for (const frame of frames) {
        await appendJournal(options.journalPath, { planId: plan.planId, outcome: "pending", target, frameHex: frame.hex });
        connection.sendConfigurationWrite(frame.bytes);
        await delay(pacingMs);
      }
    } catch (error) {
      await appendJournal(options.journalPath, { planId: plan.planId, outcome: "unknown", target, detail: (error as Error).message });
      throw new Error(`Write outcome for ${target} is unknown: ${(error as Error).message}`);
    }

    const observed = await exportConfiguration(connection, device, { timeoutMs, retries: 0 }).catch(async (error: Error) => {
      await appendJournal(options.journalPath, { planId: plan.planId, outcome: "unknown", target, detail: `Read-back failed: ${error.message}` });
      throw new Error(`Write may have landed for ${target}, but read-back failed: ${error.message}`);
    });
    if (snapshotHash(observed) !== snapshotHash(expected)) {
      await appendJournal(options.journalPath, { planId: plan.planId, outcome: "failed", target, detail: "Full snapshot verification mismatch" });
      throw new Error(`Verification failed for ${target}; restore manually from ${backupPath}`);
    }
    await appendJournal(options.journalPath, { planId: plan.planId, outcome: "verified", target });
    progressive = observed;
  }

  // Firmware disables the LED display while receiving an encoder bulk-transfer
  // write and only re-enables it from the confirmation animation fired by a
  // global-settings write (or a USB replug). Without this, encoder-only plans
  // leave the display dark until the device is unplugged and replugged.
  if (needsDisplayRefresh) {
    const [refreshFrame] = encodeGlobalDryRun(progressive.globals.rawTags, policy);
    await appendJournal(options.journalPath, {
      planId: plan.planId,
      outcome: "pending",
      target: "globals",
      frameHex: refreshFrame!.hex,
      detail: "display re-enable after encoder write",
    });
    try {
      connection.sendConfigurationWrite(refreshFrame!.bytes);
      await delay(pacingMs);
    } catch (error) {
      await appendJournal(options.journalPath, {
        planId: plan.planId,
        outcome: "unknown",
        target: "globals",
        detail: `Display re-enable write failed: ${(error as Error).message}`,
      });
      throw new Error(`Requested changes were verified, but the display re-enable write outcome is unknown: ${(error as Error).message}`);
    }

    // This frame rewrites every global tag verbatim, including the identity and
    // topology tags invariant 8 keeps isolated, so confirm it changed nothing
    // rather than assuming the round trip is lossless.
    const observed = await exportConfiguration(connection, device, { timeoutMs, retries: 0 }).catch(async (error: Error) => {
      await appendJournal(options.journalPath, {
        planId: plan.planId,
        outcome: "unknown",
        target: "globals",
        detail: `Display re-enable read-back failed: ${error.message}`,
      });
      throw new Error(`Requested changes were verified, but the display re-enable read-back failed: ${error.message}`);
    });
    if (snapshotHash(observed) !== snapshotHash(progressive)) {
      await appendJournal(options.journalPath, {
        planId: plan.planId,
        outcome: "failed",
        target: "globals",
        detail: "Display re-enable altered device state",
      });
      throw new Error(`Display re-enable write altered device state; restore manually from ${backupPath}`);
    }
    await appendJournal(options.journalPath, { planId: plan.planId, outcome: "verified", target: "globals", detail: "display re-enable" });
    progressive = observed;
  }

  await appendJournal(options.journalPath, { planId: plan.planId, outcome: "complete" });
  return { backupPath, postSnapshot: progressive };
}
