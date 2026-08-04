import type { DeviceDescriptor, ConfigExport } from "./model.js";
import type { ConfigurationWriteConnection } from "./midi.js";
import { exportConfiguration } from "./exporter.js";
import { appendJournal } from "./journal.js";
import { assertValidPlan, expectedSnapshotAfterChanges, type PatchPlan } from "./planner.js";
import { snapshotHash } from "./snapshot.js";

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
  await appendJournal(options.journalPath, { planId: plan.planId, outcome: "complete" });
  return { backupPath, postSnapshot: progressive };
}
