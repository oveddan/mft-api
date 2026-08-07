#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { exportConfiguration } from "./exporter.js";
import { RtMidiReadOnlyBackend, type MidiConnection } from "./midi.js";
import type { DeviceDescriptor } from "./model.js";

export interface ReadOnlyBackend {
  discover(timeoutMs: number): Promise<DeviceDescriptor[]>;
  connect(device: DeviceDescriptor): MidiConnection;
}

export interface UiServerOptions {
  backend?: ReadOnlyBackend;
  timeoutMs?: number;
}

const ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/colors.js", { file: "colors.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function classifyError(error: Error): { status: number; code: string; message: string } {
  const message = error.message;
  if (/permission|not permitted|access denied|operation not allowed/i.test(message)) {
    return { status: 403, code: "MIDI_PERMISSION", message: `MIDI permission was denied: ${message}` };
  }
  if (/no midi fighter|disconnected|does not exist|invalid port|not open/i.test(message)) {
    return { status: 409, code: "DEVICE_DISCONNECTED", message: `The Twister is disconnected or unavailable: ${message}` };
  }
  if (/malformed|invalid .*response|incomplete tag|expected .*response/i.test(message)) {
    return { status: 502, code: "MALFORMED_RESPONSE", message: `The controller returned malformed data: ${message}` };
  }
  if (/timed out|pull failed|empty configuration/i.test(message)) {
    return { status: 504, code: "PARTIAL_READ", message: `The configuration read did not complete: ${message}` };
  }
  return { status: 500, code: "MIDI_ERROR", message };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new Error("Expected application/json request body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function publicDevice(device: DeviceDescriptor, index: number): unknown {
  return {
    index,
    inputPort: device.inputPort.name,
    outputPort: device.outputPort.name,
    familyId: device.identity.familyId,
    modelId: device.identity.modelId,
    firmwareDate: device.identity.firmwareDate,
  };
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const asset = ASSETS.get(pathname);
  if (!asset) return false;
  const path = new URL(`../ui/${asset.file}`, import.meta.url);
  const data = await readFile(path);
  response.writeHead(200, {
    "content-type": asset.type,
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
  return true;
}

export function createUiServer(options: UiServerOptions = {}): Server {
  const backend = options.backend ?? new RtMidiReadOnlyBackend();
  const timeoutMs = options.timeoutMs ?? 750;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/devices") {
        if (request.method !== "GET") return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } });
        const devices = await backend.discover(timeoutMs);
        return json(response, 200, { devices: devices.map(publicDevice) });
      }
      if (url.pathname === "/api/export") {
        if (request.method !== "POST") return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } });
        const body = await readJson(request);
        const deviceIndex = body.deviceIndex;
        if (!Number.isInteger(deviceIndex) || (deviceIndex as number) < 0 || Object.keys(body).some((key) => key !== "deviceIndex")) {
          return json(response, 400, { error: { code: "INVALID_REQUEST", message: "deviceIndex must be the only field and a non-negative integer" } });
        }
        const devices = await backend.discover(timeoutMs);
        const device = devices[deviceIndex as number];
        if (!device) return json(response, 409, { error: { code: "DEVICE_DISCONNECTED", message: "The selected Twister is no longer connected" } });
        const connection = backend.connect(device);
        try {
          const snapshot = await exportConfiguration(connection, device, { timeoutMs });
          return json(response, 200, { snapshot });
        } finally {
          connection.close();
        }
      }
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: { code: "NOT_FOUND", message: "No such read-only API endpoint" } });
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET and HEAD are allowed" } });
      if (await serveAsset(url.pathname, response)) return;
      json(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (error instanceof SyntaxError || /Expected application|Expected a JSON|too large/.test(error.message)) {
        return json(response, 400, { error: { code: "INVALID_REQUEST", message: error.message } });
      }
      const classified = classifyError(error);
      json(response, classified.status, { error: { code: classified.code, message: classified.message } });
    }
  });
}

export async function startUiServer(host = "127.0.0.1", port = 0): Promise<{ server: Server; url: string }> {
  const server = createUiServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine UI server address");
  return { server, url: `http://${host}:${address.port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.MFT_CONFIG_UI_HOST ?? "127.0.0.1";
  const port = Number(process.env.MFT_CONFIG_UI_PORT ?? "4783");
  startUiServer(host, port)
    .then(({ url }) => process.stdout.write(`MFT Config read-only UI: ${url}\n`))
    .catch((error: Error) => {
      process.stderr.write(`mft-config ui: ${error.message}\n`);
      process.exitCode = 1;
    });
}
