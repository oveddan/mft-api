import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ReadOnlyMidiConnection, RtMidiReadOnlyBackend, type MessageHandler, type MidiConnection } from "../src/midi.js";
import type { DeviceDescriptor } from "../src/model.js";
import { assertReadOnlyRequest } from "../src/protocol.js";
import { createUiServer, type ReadOnlyBackend } from "../src/ui-server.js";

const GLOBALS = [0, 4, 1, 1, 2, 0, 3, 9, 4, 0, 5, 0, 6, 8, 7, 0, 8, 63, 9, 127, 31, 127, 32, 100, 33, 1, 34, 6, 35, 3, 36, 7, 37, 1, 38, 1];
const ENCODER = [10, 1, 11, 0, 12, 1, 13, 2, 14, 12, 15, 0, 16, 1, 17, 34, 18, 1, 19, 25, 20, 5, 21, 63, 22, 2, 23, 0, 24, 5];

const device: DeviceDescriptor = {
  inputPort: { index: 0, name: "Twister In" }, outputPort: { index: 1, name: "Twister Out" },
  identity: { manufacturerId: [0, 1, 121], familyId: 5, modelId: 1, firmwareBytes: [32, 38, 7, 2], firmwareDate: "2026-07-02" },
};

class FakeReadOnlyConnection implements MidiConnection {
  readonly sent: number[][] = [];
  closed = false;
  private readonly handlers = new Set<MessageHandler>();

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    const bytes = Array.from(message); this.sent.push(bytes);
    if (bytes[4] === 5) this.emit([0xf0, 0, 1, 0x79, 5, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]);
    if (bytes[4] === 2) this.emit([0xf0, 0, 1, 0x79, 2, 1, ...GLOBALS, 0xf7]);
    if (bytes[4] === 4) {
      const tag = bytes[6]!;
      if (tag === 65) return this.emit([0xf0, 0, 1, 0x79, 4, 0, 65, 1, 1, 0, 0xf7]);
      this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...ENCODER.slice(0, 24), 0xf7]);
      this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, 6, ...ENCODER.slice(24), 0xf7]);
    }
  }
  subscribe(handler: MessageHandler): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  close(): void { this.closed = true; }
  private emit(message: number[]): void { for (const handler of [...this.handlers]) handler(message); }
}

async function withServer(backend: ReadOnlyBackend, run: (base: string) => Promise<void>): Promise<void> {
  const server = createUiServer({ backend, timeoutMs: 100 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("read-only UI backend has no apply connection constructor", () => {
  const backend = new RtMidiReadOnlyBackend();
  assert.equal("connectForApply" in backend, false);
  assert.deepEqual(Object.getOwnPropertyNames(RtMidiReadOnlyBackend.prototype).sort(), ["connect", "constructor", "discover"]);
});

test("read-only transport blocks mutating SysEx before it reaches the MIDI output", () => {
  const delivered: number[][] = [];
  const transport: MidiConnection = {
    send: (message) => delivered.push(Array.from(message)),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  const connection = new ReadOnlyMidiConnection(transport);
  connection.send([0xf0, 0, 1, 0x79, 2, 0, 0xf7]);
  assert.equal(delivered.length, 1);
  for (const mutating of [
    [0xf0, 0, 1, 0x79, 1, 0, 4, 0xf7],
    [0xf0, 0, 1, 0x79, 4, 0, 1, 1, 1, 2, 19, 43, 0xf7],
    [0xf0, 0, 1, 0x79, 3, 2, 0xf7],
  ]) assert.throws(() => connection.send(mutating), /Blocked mutating/);
  assert.equal(delivered.length, 1);
});

test("UI API exports a complete snapshot using only allowlisted read requests", async () => {
  const connection = new FakeReadOnlyConnection();
  const backend: ReadOnlyBackend = { discover: async () => [device], connect: () => connection };
  await withServer(backend, async (base) => {
    const devices = await fetch(`${base}/api/devices`).then((response) => response.json()) as { devices: unknown[] };
    assert.equal(devices.devices.length, 1);
    const response = await fetch(`${base}/api/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIndex: 0 }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { snapshot: { banks: unknown[]; globals: { rawTags: Record<string, number> } } };
    assert.equal(body.snapshot.banks.length, 4);
    assert.equal(body.snapshot.globals.rawTags["38"], 1);
    assert(connection.sent.length > 60);
    for (const frame of connection.sent) assert.doesNotThrow(() => assertReadOnlyRequest(frame));
    assert.equal(connection.closed, true);
  });
});

test("UI server has no mutation route and never opens a connection for one", async () => {
  let connections = 0;
  const backend: ReadOnlyBackend = { discover: async () => [device], connect: () => { connections += 1; return new FakeReadOnlyConnection(); } };
  await withServer(backend, async (base) => {
    for (const path of ["apply", "plan", "write", "reset", "bootloader", "system"]) {
      const response = await fetch(`${base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 404);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "NOT_FOUND");
    }
  });
  assert.equal(connections, 0);
});

test("concurrent /api/export requests do not race: the second is rejected instead of sharing a connection", async () => {
  let connectionsOpened = 0;
  let inFlightSends = 0;
  let maxConcurrentSends = 0;

  class SlowFakeConnection implements MidiConnection {
    readonly sent: number[][] = [];
    closed = false;
    private readonly handlers = new Set<MessageHandler>();

    send(message: ArrayLike<number>): void {
      assertReadOnlyRequest(message);
      const bytes = Array.from(message);
      this.sent.push(bytes);
      inFlightSends += 1;
      maxConcurrentSends = Math.max(maxConcurrentSends, inFlightSends);
      // Respond asynchronously so a second concurrent request's send() calls could
      // interleave with this one's if there were no single-flight guard.
      setTimeout(() => {
        inFlightSends -= 1;
        if (bytes[4] === 5) this.emit([0xf0, 0, 1, 0x79, 5, 1, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]);
        if (bytes[4] === 2) this.emit([0xf0, 0, 1, 0x79, 2, 1, ...GLOBALS, 0xf7]);
        if (bytes[4] === 4) {
          const tag = bytes[6]!;
          if (tag === 65) return this.emit([0xf0, 0, 1, 0x79, 4, 0, 65, 1, 1, 0, 0xf7]);
          this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 1, 2, 24, ...ENCODER.slice(0, 24), 0xf7]);
          this.emit([0xf0, 0, 1, 0x79, 4, 0, tag, 2, 2, 6, ...ENCODER.slice(24), 0xf7]);
        }
      }, 1);
    }
    subscribe(handler: MessageHandler): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
    close(): void { this.closed = true; }
    private emit(message: number[]): void { for (const handler of [...this.handlers]) handler(message); }
  }

  const backend: ReadOnlyBackend = {
    discover: async () => [device],
    connect: () => { connectionsOpened += 1; return new SlowFakeConnection(); },
  };

  await withServer(backend, async (base) => {
    const request = () => fetch(`${base}/api/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIndex: 0 }) });
    const [first, second] = await Promise.all([request(), request()]);
    const statuses = [first.status, second.status].sort();
    // Exactly one request wins and reads a complete snapshot; the other is rejected
    // with 409 rather than being served from a second, concurrently-opened connection
    // whose replies could interleave with the first (matched only by protocol tag).
    assert.deepEqual(statuses, [200, 409]);
    const rejected = first.status === 409 ? first : second;
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, "EXPORT_IN_PROGRESS");
    assert.equal(connectionsOpened, 1);
  });

  // A follow-up export after the first completes should succeed normally (the guard
  // releases once the in-flight export finishes, it doesn't wedge the server).
  const backend2: ReadOnlyBackend = { discover: async () => [device], connect: () => new SlowFakeConnection() };
  await withServer(backend2, async (base) => {
    const response = await fetch(`${base}/api/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIndex: 0 }) });
    assert.equal(response.status, 200);
  });
});

test("/api/export rejects a request whose inputPort/outputPort no longer match the freshly discovered device", async () => {
  const connection = new FakeReadOnlyConnection();
  const backend: ReadOnlyBackend = { discover: async () => [device], connect: () => connection };
  await withServer(backend, async (base) => {
    const response = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceIndex: 0, inputPort: "Some Other Device In", outputPort: "Twister Out" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "DEVICE_LIST_CHANGED");
  });
});

test("requests with a Host header that does not name this server are rejected", async () => {
  // fetch() refuses to let callers override the Host header (undici derives it from the
  // URL), so this exercises the real attack surface -- an arbitrary Host header sent over
  // the wire, e.g. by DNS rebinding or a raw client -- with a low-level http.request.
  const backend: ReadOnlyBackend = { discover: async () => [device], connect: () => new FakeReadOnlyConnection() };
  await withServer(backend, async (base) => {
    const { port } = new URL(base);
    const body = await new Promise<{ status: number; json: { error: { code: string } } }>((resolvePromise, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port: Number(port), path: "/api/devices", method: "GET", headers: { host: "evil.example:80" } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolvePromise({ status: response.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(body.status, 400);
    assert.equal(body.json.error.code, "INVALID_HOST");
  });
});

test("UI server reports permission, malformed, partial, and disconnected reads clearly", async () => {
  for (const [message, status, code] of [
    ["MIDI permission denied", 403, "MIDI_PERMISSION"],
    ["Malformed response", 502, "MALFORMED_RESPONSE"],
    ["Global configuration pull failed after 2 attempts", 504, "PARTIAL_READ"],
  ] as const) {
    const backend: ReadOnlyBackend = { discover: async () => { throw new Error(message); }, connect: () => new FakeReadOnlyConnection() };
    await withServer(backend, async (base) => {
      const response = await fetch(`${base}/api/devices`); assert.equal(response.status, status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
    });
  }
  const backend: ReadOnlyBackend = { discover: async () => [], connect: () => new FakeReadOnlyConnection() };
  await withServer(backend, async (base) => {
    const response = await fetch(`${base}/api/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceIndex: 0 }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "DEVICE_DISCONNECTED");
  });
});
