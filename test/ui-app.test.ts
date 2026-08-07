import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";

import { exportConfiguration } from "../src/exporter.js";
import type { ConfigExport, DeviceDescriptor } from "../src/model.js";
import type { MessageHandler, MidiConnection } from "../src/midi.js";
import { assertReadOnlyRequest } from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = resolve(here, "../ui/index.html");
const appJsPath = resolve(here, "../ui/app.js");

const GLOBAL_PAIRS = [
  0, 4, 1, 1,
  2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0,
  8, 63, 9, 127,
  31, 127, 32, 100, 33, 1, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1,
];

const ENCODER_PAIRS = [
  10, 1, 11, 0, 12, 0, 13, 2, 14, 12,
  15, 0, 16, 1, 17, 34, 18, 1, 19, 25,
  20, 5, 21, 63, 22, 2, 23, 0, 24, 5,
];

const device: DeviceDescriptor = {
  inputPort: { index: 0, name: "Midi Fighter Twister" },
  outputPort: { index: 0, name: "Midi Fighter Twister" },
  identity: {
    manufacturerId: [0, 1, 0x79],
    familyId: 5,
    modelId: 1,
    firmwareBytes: [0x20, 0x26, 7, 2],
    firmwareDate: "2026-07-02",
  },
};

class FakeFourBankTwister implements MidiConnection {
  readonly sent: number[][] = [];
  private readonly handlers = new Set<MessageHandler>();

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    const bytes = Array.from(message);
    this.sent.push(bytes);
    const command = bytes[4];
    if (command === 0x05) {
      this.emit([0xf0, 0, 1, 0x79, 5, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]);
    } else if (command === 0x02) {
      this.emit([0xf0, 0, 1, 0x79, 2, 1, ...GLOBAL_PAIRS, 0xf7]);
    } else if (command === 0x04) {
      const tag = bytes[6]!;
      if (tag === 65) {
        this.emit([0xf0, 0, 1, 0x79, 4, 0, 65, 1, 1, 0, 0xf7]);
      } else {
        this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...ENCODER_PAIRS.slice(0, 24), 0xf7]);
        this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, 6, ...ENCODER_PAIRS.slice(24), 0xf7]);
      }
    }
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {}

  private emit(message: number[]): void {
    for (const handler of [...this.handlers]) handler(message);
  }
}

async function validSnapshot(): Promise<ConfigExport> {
  const connection = new FakeFourBankTwister();
  return exportConfiguration(connection, device, { timeoutMs: 100, retries: 0 });
}

interface AppModule {
  assertSnapshot(value: unknown): unknown;
  renderSnapshot(snapshot: unknown, source: string): void;
}

/** Loads ui/app.js against a fresh DOM built from the real ui/index.html, mirroring
 * what a browser would do. Each call gets an isolated `document`/`window` and a
 * cache-busted module import so tests don't share app.js module state. */
async function loadApp(): Promise<{ document: Document; app: AppModule }> {
  const html = readFileSync(indexHtmlPath, "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/" });
  (globalThis as Record<string, unknown>).window = dom.window;
  (globalThis as Record<string, unknown>).document = dom.window.document;
  (globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
  const app = (await import(`${pathToFileURL(appJsPath).href}?cachebust=${Date.now()}-${Math.random()}`)) as unknown as AppModule;
  return { document: dom.window.document, app };
}

test("assertSnapshot rejects a snapshot missing globals fields the renderer reads", async () => {
  const { app } = await loadApp();
  const snapshot = await validSnapshot();
  const malformed = structuredClone(snapshot) as Record<string, unknown>;
  delete (malformed.globals as Record<string, unknown>).colorMap;
  assert.throws(() => app.assertSnapshot(malformed), /global fields/i);
});

test("a malformed offline snapshot does not corrupt the viewer: empty state stays intact", async () => {
  const { document, app } = await loadApp();
  const snapshot = await validSnapshot();
  const malformed = structuredClone(snapshot) as Record<string, unknown>;
  delete (malformed.globals as Record<string, unknown>).superKnob;

  assert.throws(() => app.renderSnapshot(malformed, "bad import"));

  // Nothing should have been committed: the empty state remains visible, the viewer
  // remains hidden, and Download JSON remains disabled (it would otherwise export
  // corrupt/half-applied data).
  assert.equal((document.getElementById("empty-state") as HTMLElement).hidden, false);
  assert.equal((document.getElementById("viewer") as HTMLElement).hidden, true);
  assert.equal((document.getElementById("download-button") as HTMLButtonElement).disabled, true);
  assert.equal((document.getElementById("identity-fields") as HTMLElement).children.length, 0);
});

test("a malformed snapshot after a good read leaves the previous good snapshot displayed, not a spliced mix", async () => {
  const { document, app } = await loadApp();
  const good = await validSnapshot();
  app.renderSnapshot(good, "Live controller");
  assert.equal((document.getElementById("viewer") as HTMLElement).hidden, false);
  const goodDate = (good as ConfigExport).device.firmware.date;
  const identityText = (document.getElementById("identity-fields") as HTMLElement).textContent ?? "";
  assert(identityText.includes(goodDate));

  const malformed = structuredClone(good) as Record<string, unknown>;
  delete (malformed.globals as Record<string, unknown>).colorMap;
  assert.throws(() => app.renderSnapshot(malformed, "bad import"));

  // The viewer should still show the last good snapshot's data (rolled back render),
  // never a mix of the new device header and old grid/globals.
  assert.equal((document.getElementById("viewer") as HTMLElement).hidden, false);
  assert.equal((document.getElementById("download-button") as HTMLButtonElement).disabled, false);
  const identityTextAfter = (document.getElementById("identity-fields") as HTMLElement).textContent ?? "";
  assert(identityTextAfter.includes(goodDate));
  assert.equal((document.getElementById("raw-json") as HTMLElement).textContent, JSON.stringify(good, null, 2));
});

test("a valid snapshot renders successfully and unhides the viewer", async () => {
  const { document, app } = await loadApp();
  const snapshot = await validSnapshot();
  app.renderSnapshot(snapshot, "Live controller");
  assert.equal((document.getElementById("empty-state") as HTMLElement).hidden, true);
  assert.equal((document.getElementById("viewer") as HTMLElement).hidden, false);
  assert.equal((document.getElementById("download-button") as HTMLButtonElement).disabled, false);
});
