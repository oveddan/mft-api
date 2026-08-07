import type { ConfigExport, DeviceDescriptor, EncoderExport } from "./model.js";
import { normalizeEncoder, normalizeGlobals } from "./model.js";
import { encoderTransferTag, firmwarePolicy } from "./compatibility.js";
import type { MidiConnection } from "./midi.js";
import {
  assembleBulkParts,
  bytesToHex,
  getDeviceIdRequest,
  parseBulkPart,
  parseDeviceIdResponse,
  parseGlobalResponse,
  parseTagValues,
  pullEncoderRequest,
  pullGlobalsRequest,
  type BulkPart,
} from "./protocol.js";
import { findUsbSerial } from "./usb.js";

interface ExportOptions {
  timeoutMs?: number;
  retries?: number;
}

function waitForMessage<T>(
  connection: MidiConnection,
  send: () => void,
  parse: (message: number[]) => T | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let unsubscribe = () => {};
    let parseError: Error | undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(parseError ?? new Error(`Timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    unsubscribe = connection.subscribe((message) => {
      try {
        const result = parse(message);
        if (result === undefined) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      } catch (error) {
        parseError = error as Error;
      }
    });
    send();
  });
}

async function withRetries<T>(operation: () => Promise<T>, retries: number, context: string): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(`${context} failed after ${retries + 1} attempt(s): ${lastError?.message}`);
}

async function pullGlobals(connection: MidiConnection, timeoutMs: number, retries: number): Promise<Map<number, number>> {
  return withRetries(
    () =>
      waitForMessage(
        connection,
        () => connection.send(pullGlobalsRequest()),
        (message) => message[4] === 0x02 ? parseGlobalResponse(message) : undefined,
        timeoutMs,
      ),
    retries,
    "Global configuration pull",
  );
}

async function pullDeviceId(connection: MidiConnection, timeoutMs: number): Promise<number[] | null> {
  try {
    return await waitForMessage(
      connection,
      () => connection.send(getDeviceIdRequest()),
      (message) => {
        if (message[4] !== 0x05) return undefined;
        return parseDeviceIdResponse(message);
      },
      timeoutMs,
    );
  } catch {
    return null;
  }
}

async function pullEncoderData(
  connection: MidiConnection,
  tag: number,
  timeoutMs: number,
  retries: number,
): Promise<number[]> {
  return withRetries(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const parts = new Map<number, BulkPart>();
        let expectedTotal: number | undefined;
        let malformed: Error | undefined;
        const timer = setTimeout(() => {
          unsubscribe();
          reject(malformed ?? new Error(`Timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        const unsubscribe = connection.subscribe((message) => {
          try {
            const part = parseBulkPart(message);
            if (part.tag !== tag) return;
            expectedTotal ??= part.total;
            if (part.total !== expectedTotal) throw new Error("Bulk response changed total part count");
            parts.set(part.part, part);
            if (parts.size !== expectedTotal) return;
            clearTimeout(timer);
            unsubscribe();
            resolve(assembleBulkParts([...parts.values()]));
          } catch (error) {
            if (message[4] === 0x04) malformed = error as Error;
          }
        });
        connection.send(pullEncoderRequest(tag));
      }),
    retries,
    `Encoder tag ${tag} pull`,
  );
}

async function detectBankCount(
  connection: MidiConnection,
  firmwareDate: string,
  timeoutMs: number,
  retries: number,
): Promise<4 | 8> {
  if (firmwareDate < "2026-07-02") return 4;
  const probe = await pullEncoderData(connection, 65, timeoutMs, retries);
  return probe.length === 0 ? 4 : 8;
}

export async function exportConfiguration(
  connection: MidiConnection,
  device: DeviceDescriptor,
  options: ExportOptions = {},
): Promise<ConfigExport> {
  const timeoutMs = options.timeoutMs ?? 500;
  const retries = options.retries ?? 1;
  const warnings: string[] = [];

  const deviceId = await pullDeviceId(connection, timeoutMs);
  const globalValues = await pullGlobals(connection, timeoutMs, retries);

  let unitId: ConfigExport["device"]["unitId"] = deviceId
    ? { source: "sysex-0x05", hex: bytesToHex(deviceId) }
    : null;
  if (!unitId) {
    warnings.push("Command 0x05 did not return a valid 7-bit SysEx identity");
    const fallback = await findUsbSerial([device.inputPort.name, device.outputPort.name]);
    if (fallback.serial) unitId = { source: "usb-serial", hex: fallback.serial };
    if (fallback.warning) warnings.push(fallback.warning);
  }

  const bankCount = await detectBankCount(connection, device.identity.firmwareDate, timeoutMs, retries);
  const banks: ConfigExport["banks"] = Array.from({ length: bankCount }, (_, index) => ({
    number: index + 1,
    encoders: [],
  }));

  const encoderCount = bankCount * 16;
  const policy = firmwarePolicy(device.identity.firmwareDate);
  for (let zeroBased = 0; zeroBased < encoderCount; zeroBased += 1) {
    const encoderNumber = zeroBased + 1;
    const bank = Math.floor(zeroBased / 16) + 1;
    const encoderInBank = (zeroBased % 16) + 1;
    const transferTag = encoderTransferTag(bank, encoderInBank, bankCount, policy);
    const data = await pullEncoderData(connection, transferTag, timeoutMs, retries);
    if (data.length === 0) throw new Error(`Encoder ${encoderNumber} returned an empty configuration`);
    const encoder: EncoderExport = normalizeEncoder(
      parseTagValues(data),
      encoderInBank,
      device.identity.firmwareDate,
      warnings,
    );
    banks[Math.floor(zeroBased / 16)]!.encoders.push(encoder);
  }

  return {
    schemaVersion: "djtt.mft.config-export.v1",
    capturedAt: new Date().toISOString(),
    device: {
      manufacturer: "DJ TechTools",
      manufacturerId: device.identity.manufacturerId,
      familyId: device.identity.familyId,
      modelId: device.identity.modelId,
      firmware: {
        date: device.identity.firmwareDate,
        identityBytes: device.identity.firmwareBytes,
      },
      unitId,
      midiPorts: { input: device.inputPort.name, output: device.outputPort.name },
    },
    capabilities: { bankCount, encodersPerBank: 16 },
    globals: normalizeGlobals(globalValues, warnings),
    banks,
    warnings,
  };
}
