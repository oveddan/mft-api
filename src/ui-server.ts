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

/**
 * Only accept requests whose Host header names this server, so an unrelated page open
 * in the user's browser can't reach the local MIDI-reading API cross-origin (directly,
 * or via DNS rebinding to make the request appear same-origin).
 */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isAllowedHost(request: IncomingMessage): boolean {
  const header = request.headers.host;
  if (!header) return false;
  const separatorIndex = header.lastIndexOf(":");
  const hostname = separatorIndex === -1 ? header : header.slice(0, separatorIndex);
  const portPart = separatorIndex === -1 ? undefined : header.slice(separatorIndex + 1);
  if (!ALLOWED_HOSTNAMES.has(hostname.toLowerCase())) return false;
  const localPort = request.socket.localPort;
  if (portPart === undefined || localPort === undefined) return false;
  return Number(portPart) === localPort;
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

  // Single-flight guard: /api/export opens a fresh pair of MIDI ports and matches
  // replies purely on protocol tag, so two concurrent exports could open the same
  // ports twice and let one request's replies satisfy the other, silently producing
  // a corrupt snapshot. Only one export runs at a time; a concurrent request gets 409.
  let exportInFlight = false;

  return createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request)) {
        return json(response, 400, { error: { code: "INVALID_HOST", message: "Host header is not allowed" } });
      }
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
        const extraKeys = Object.keys(body).filter((key) => key !== "deviceIndex" && key !== "inputPort" && key !== "outputPort");
        const inputPort = body.inputPort;
        const outputPort = body.outputPort;
        if (
          !Number.isInteger(deviceIndex) ||
          (deviceIndex as number) < 0 ||
          (inputPort !== undefined && typeof inputPort !== "string") ||
          (outputPort !== undefined && typeof outputPort !== "string") ||
          extraKeys.length > 0
        ) {
          return json(response, 400, {
            error: { code: "INVALID_REQUEST", message: "deviceIndex must be a non-negative integer; inputPort/outputPort, if present, must be strings" },
          });
        }
        if (exportInFlight) {
          return json(response, 409, { error: { code: "EXPORT_IN_PROGRESS", message: "Another export is already reading the device; try again shortly" } });
        }
        exportInFlight = true;
        try {
          const devices = await backend.discover(timeoutMs);
          const device = devices[deviceIndex as number];
          if (!device) return json(response, 409, { error: { code: "DEVICE_DISCONNECTED", message: "The selected Twister is no longer connected" } });
          // Devices are re-discovered fresh on every export, and `deviceIndex` is only a
          // position in that ordering. If the browser's earlier device list is stale
          // (a device was unplugged/replugged in between), the array may have reordered
          // and the same index would silently pick a different device. Re-checking the
          // port names the browser saw at discovery time turns that into a clear error
          // instead of a mislabeled (still read-only) export. This is not a perfect
          // identity check across OS/driver quirks, but it is the cheap option; a fully
          // robust fix would need a stable device key threaded through discovery.
          if (
            (inputPort !== undefined && inputPort !== device.inputPort.name) ||
            (outputPort !== undefined && outputPort !== device.outputPort.name)
          ) {
            return json(response, 409, {
              error: { code: "DEVICE_LIST_CHANGED", message: "The device list changed since it was last discovered; rescan and try again" },
            });
          }
          const connection = backend.connect(device);
          try {
            const snapshot = await exportConfiguration(connection, device, { timeoutMs });
            return json(response, 200, { snapshot });
          } finally {
            connection.close();
          }
        } finally {
          exportInFlight = false;
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

const LOCAL_ONLY_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Binding to anything other than loopback exposes the read-only MIDI API to the network; docs already say this isn't recommended, so warn loudly. */
export function warnIfNonLocalHost(host: string): void {
  if (!LOCAL_ONLY_BIND_HOSTS.has(host.toLowerCase())) {
    process.stderr.write(
      `mft-config ui: WARNING binding to "${host}" exposes the local MIDI read-only API to the network. This is not recommended; prefer 127.0.0.1 or localhost.\n`,
    );
  }
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
  warnIfNonLocalHost(host);
  startUiServer(host, port)
    .then(({ url }) => process.stdout.write(`MFT Config read-only UI: ${url}\n`))
    .catch((error: Error) => {
      process.stderr.write(`mft-config ui: ${error.message}\n`);
      process.exitCode = 1;
    });
}
