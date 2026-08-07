#!/usr/bin/env node

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { exportConfiguration } from "./exporter.js";
import type { ConfigExport } from "./model.js";
import { createPatchPlan, type PatchInput, type PatchPlan } from "./planner.js";
import { applyPatchPlan } from "./applier.js";
import { assertPlanNotConsumed } from "./journal.js";
import { stateDirectory } from "./state.js";

interface Arguments {
  command: "list" | "export" | "plan" | "apply" | "ui" | "help";
  device?: number;
  out?: string;
  timeoutMs: number;
  snapshot?: string;
  sets: string[];
  plan?: string;
  yes: boolean;
}

function usage(): string {
  return `Usage:
  mft-config list [--timeout <milliseconds>]
  mft-config export [--device <index>] [--out <file>] [--timeout <milliseconds>]
  mft-config plan --snapshot <config.json> --set <path=value> [--set <path=value>] [--out <file>]
  mft-config apply --plan <patch-plan.json> --yes [--device <index>]
  mft-config ui

This tool only sends Universal Identity, global pull (0x02), encoder bulk-pull
(0x04/0x01), and device-ID pull (0x05) messages. The plan command is offline.
Only apply can write settings, and it requires an eligible content-addressed plan
plus explicit --yes confirmation.`;
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help", timeoutMs: 500, sets: [], yes: false };
  }
  if (command !== "list" && command !== "export" && command !== "plan" && command !== "apply" && command !== "ui") throw new Error(`Unknown command: ${command}`);

  const result: Arguments = { command, timeoutMs: 500, sets: [], yes: false };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--device" && value !== undefined) {
      result.device = Number.parseInt(value, 10);
      index += 1;
    } else if (option === "--out" && value !== undefined) {
      result.out = value;
      index += 1;
    } else if (option === "--timeout" && value !== undefined) {
      result.timeoutMs = Number.parseInt(value, 10);
      index += 1;
    } else if (option === "--snapshot" && value !== undefined) {
      result.snapshot = value;
      index += 1;
    } else if (option === "--set" && value !== undefined) {
      result.sets.push(value);
      index += 1;
    } else if (option === "--plan" && value !== undefined) {
      result.plan = value;
      index += 1;
    } else if (option === "--yes") {
      result.yes = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${option}`);
    }
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 100) {
    throw new Error("--timeout must be an integer of at least 100 milliseconds");
  }
  if (result.device !== undefined && (!Number.isInteger(result.device) || result.device < 0)) {
    throw new Error("--device must be a non-negative integer");
  }
  if (command === "plan" && !result.snapshot) throw new Error("plan requires --snapshot <config.json>");
  if (command === "plan" && result.sets.length === 0) throw new Error("plan requires at least one --set <path=value>");
  if (command === "apply" && !result.plan) throw new Error("apply requires --plan <patch-plan.json>");
  if (command === "apply" && !result.yes) throw new Error("apply requires explicit confirmation with --yes");
  return result;
}

function parseSet(expression: string): PatchInput {
  const separator = expression.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid --set expression ${expression}; expected path=value`);
  return { path: expression.slice(0, separator), value: expression.slice(separator + 1) };
}

async function writeAtomically(path: string, data: string): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv[1]?.endsWith("mft-export")) {
    process.stderr.write("mft-export is deprecated; use mft-config instead.\n");
  }
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (args.command === "plan") {
    const snapshot = JSON.parse(await readFile(resolve(args.snapshot!), "utf8")) as ConfigExport;
    const plan = createPatchPlan(snapshot, args.sets.map(parseSet));
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    if (args.out) {
      await writeAtomically(args.out, json);
      process.stderr.write(`Wrote offline patch plan to ${resolve(args.out)}\n`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (args.command === "ui") {
    const { startUiServer } = await import("./ui-server.js");
    const host = process.env.MFT_CONFIG_UI_HOST ?? "127.0.0.1";
    const port = Number(process.env.MFT_CONFIG_UI_PORT ?? "4783");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MFT_CONFIG_UI_PORT must be an integer from 0 to 65535");
    const { url } = await startUiServer(host, port);
    process.stdout.write(`MFT Config read-only UI: ${url}\n`);
    return;
  }

  const { RtMidiBackend } = await import("./midi.js");
  const backend = new RtMidiBackend();
  const devices = await backend.discover(args.timeoutMs);
  if (args.command === "list") {
    const summary = devices.map((device, index) => ({
      index,
      inputPort: device.inputPort.name,
      outputPort: device.outputPort.name,
      familyId: device.identity.familyId,
      modelId: device.identity.modelId,
      firmwareDate: device.identity.firmwareDate,
    }));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (devices.length === 0) throw new Error("No MIDI Fighter Twister responded to identity discovery");
  if (devices.length > 1 && args.device === undefined) {
    throw new Error(`Found ${devices.length} devices; select one with --device <index>`);
  }
  const selectedIndex = args.device ?? 0;
  const device = devices[selectedIndex];
  if (!device) throw new Error(`Device index ${selectedIndex} does not exist; use the list command first`);

  if (args.command === "apply") {
    const plan = JSON.parse(await readFile(resolve(args.plan!), "utf8")) as PatchPlan;
    const stateRoot = stateDirectory();
    const journalPath = resolve(stateRoot, "journal.ndjson");
    await assertPlanNotConsumed(journalPath, plan.planId);
    const connection = backend.connectForApply(device);
    try {
      const result = await applyPatchPlan(connection, device, plan, {
        journalPath,
        timeoutMs: args.timeoutMs,
        saveBackup: async (snapshot) => {
          const stamp = new Date().toISOString().replaceAll(":", "-");
          const path = resolve(stateRoot, "backups", `${stamp}.json`);
          await writeAtomically(path, `${JSON.stringify(snapshot, null, 2)}\n`);
          return path;
        },
      });
      const postPath = resolve(stateRoot, "last-verified.json");
      await writeAtomically(postPath, `${JSON.stringify(result.postSnapshot, null, 2)}\n`);
      process.stdout.write(`Applied and verified ${plan.changes.length} change(s).\nBackup: ${result.backupPath}\nVerified snapshot: ${postPath}\n`);
    } finally {
      connection.close();
    }
    return;
  }

  const connection = backend.connect(device);
  try {
    const configuration = await exportConfiguration(connection, device, { timeoutMs: args.timeoutMs });
    const json = `${JSON.stringify(configuration, null, 2)}\n`;
    if (args.out) {
      await writeAtomically(args.out, json);
      process.stderr.write(`Exported configuration to ${resolve(args.out)}\n`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    connection.close();
  }
}

main().catch((error: Error) => {
  process.stderr.write(`mft-config: ${error.message}\n`);
  process.exitCode = 1;
});
