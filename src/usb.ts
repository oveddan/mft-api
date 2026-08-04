import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface UsbLookupResult {
  serial: string | null;
  warning?: string;
}

function collectObjects(value: unknown, result: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, result);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    result.push(object);
    for (const child of Object.values(object)) collectObjects(child, result);
  }
}

/** Best-effort USB serial fallback for macOS when command 0x05 is malformed. */
export async function findUsbSerial(midiPortNames: string[]): Promise<UsbLookupResult> {
  if (process.platform !== "darwin") {
    return { serial: null, warning: "USB serial fallback is currently implemented only for macOS" };
  }

  try {
    const { stdout } = await execFileAsync("system_profiler", ["SPUSBDataType", "-json"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    const objects: Record<string, unknown>[] = [];
    collectObjects(JSON.parse(stdout), objects);
    const serials = objects
      .filter((object) => String(object.vendor_id ?? "").toLowerCase().includes("0x2580"))
      .filter((object) => /^0x(?:[0-3]007)/i.test(String(object.product_id ?? "")))
      .map((object) => String(object.serial_num ?? "").toUpperCase())
      .filter((serial) => /^[0-9A-F]{16}$/.test(serial));

    const unique = [...new Set(serials)];
    if (unique.length === 1) return { serial: unique[0]! };
    const nameMatch = unique.find((serial) => midiPortNames.some((name) => name.includes(serial)));
    if (nameMatch) return { serial: nameMatch };
    if (unique.length > 1) {
      return { serial: null, warning: "Multiple Twister USB serials were found and none matched the MIDI port name" };
    }
    return { serial: null, warning: "No MIDI Fighter Twister USB serial was found" };
  } catch (error) {
    return { serial: null, warning: `USB serial lookup failed: ${(error as Error).message}` };
  }
}
