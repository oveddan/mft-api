import { McpServer, ProtocolError, ProtocolErrorCode, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { exportConfiguration } from "./exporter.js";
import type { MidiBackend } from "./midi.js";
import type { ConfigExport, DeviceDescriptor } from "./model.js";
import { createPatchPlan } from "./planner.js";
import { snapshotHash } from "./snapshot.js";
import { loadSkills, skillEntry, SKILLS_EXTENSION, type Skill } from "./skills.js";

// The MCP server is the primary way an agent reaches the Twister. It exposes the
// same read and offline-plan operations as the CLI, as typed tools, and serves
// the agent skill that explains them.
//
// Two properties differ from the CLI on purpose:
//
// - Plans are made only from snapshots this server exported. The agent names a
//   snapshot by ID; it never hands the server configuration JSON to plan from.
// - Device operations run one at a time. A host can issue tool calls
//   concurrently, and two discoveries probing every port at once would read
//   each other's identity replies.
//
// It is built on SDK v2, which serves both protocol eras from one factory: the
// 2025 `initialize` handshake, and the 2026-07-28 `server/discover` handshake
// the Skills Extension is specified against. A host on either era sees the
// extension declared.
//
// No MIDI port is held between calls. Each call discovers, opens, and closes,
// exactly as one CLI invocation does, so the server contends for ports with a
// DAW or the vendor utility no more than the CLI already does.
//
// There is no apply tool. Writing is disabled in the CLI until the defects in
// https://github.com/oveddan/mft-api/issues/14 are fixed, and a server tool
// would widen that boundary rather than narrow it.

const SNAPSHOT_LIMIT = 16;
const LISTING_TTL_MS = 300_000;

// These mirror the CLI's `list` output and device selection, which stay inline
// in cli.ts so this server changes nothing on the CLI's hardware paths.

function summarizeDevices(devices: DeviceDescriptor[]): unknown[] {
  return devices.map((device, index) => ({
    index,
    inputPort: device.inputPort.name,
    outputPort: device.outputPort.name,
    familyId: device.identity.familyId,
    modelId: device.identity.modelId,
    firmwareDate: device.identity.firmwareDate,
  }));
}

/** Refuses to guess between several controllers: an index is positional, not an identity. */
function selectDevice(devices: DeviceDescriptor[], index: number | undefined): DeviceDescriptor {
  if (devices.length === 0) throw new Error("No MIDI Fighter Twister responded to identity discovery");
  if (devices.length > 1 && index === undefined) {
    throw new Error(`Found ${devices.length} devices; select one with the device argument`);
  }
  const selectedIndex = index ?? 0;
  const device = devices[selectedIndex];
  if (!device) throw new Error(`Device index ${selectedIndex} does not exist; call list_devices again`);
  return device;
}

export interface McpServerOptions {
  backend: MidiBackend;
  skills: Skill[];
  version: string;
}

const timeoutMs = z
  .number()
  .int()
  .min(100)
  .max(10_000)
  .optional()
  .describe("Milliseconds to wait for each device reply. Default 500; raise it if discovery misses a connected Twister.");

const deviceIndex = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Positional index from list_devices. Required when more than one Twister is connected. Indices follow port order and are not stable identities.");

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function instructions(skills: Skill[]): string {
  const skill = skills.find((candidate) => candidate.frontmatter.name === "mft-configurator");
  return [
    "Inspect and plan changes to a DJ TechTools MIDI Fighter Twister over USB MIDI.",
    "Treat the controller as user-owned hardware: inspect by default, and plan a change only when the user asks for one.",
    "Writing settings to the device is not available through this server.",
    skill ? `Before planning a change, read the skill at ${skill.uri} and the settings reference it links to.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** State every server instance must share: one device lock, one snapshot store. */
interface SharedState {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  remember(configuration: ConfigExport): string;
  snapshots: ReadonlyMap<string, ConfigExport>;
}

function createSharedState(): SharedState {
  let queue: Promise<unknown> = Promise.resolve();
  // Keyed by snapshot hash, oldest evicted first. Insertion order is recency
  // because a re-export of an unchanged device deletes and re-inserts its key.
  const snapshots = new Map<string, ConfigExport>();
  return {
    exclusive(operation) {
      const run = queue.then(operation, operation);
      queue = run.catch(() => undefined);
      return run;
    },
    remember(configuration) {
      const id = snapshotHash(configuration);
      snapshots.delete(id);
      snapshots.set(id, configuration);
      while (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
      return id;
    },
    snapshots,
  };
}

/**
 * Returns a factory for server instances. The stdio entry point may build more
 * than one per connection while it settles the protocol era, so the device lock
 * and the snapshot store are created once here and shared by every instance.
 */
export function createMcpServerFactory(options: McpServerOptions): () => McpServer {
  const state = createSharedState();
  return () => buildServer(options, state);
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const cacheable = { resultType: "complete", ttlMs: LISTING_TTL_MS, cacheScope: "public" } as const;

function buildServer(options: McpServerOptions, state: SharedState): McpServer {
  const { backend, skills } = options;
  const { exclusive, remember, snapshots } = state;
  const skillsByUri = new Map(skills.map((skill) => [skill.uri, skill]));
  const server = new McpServer(
    { name: "mft-config", version: options.version },
    {
      capabilities: { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION]: {} } },
      instructions: instructions(skills),
    },
  );

  server.registerTool(
    "list_devices",
    {
      title: "List Twisters",
      description:
        "Discover connected MIDI Fighter Twisters by sending a Universal Identity request to every MIDI output. Returns each device's positional index, port names, and firmware date.",
      inputSchema: z.object({ timeoutMs }),
      annotations: readOnly,
    },
    ({ timeoutMs }) => exclusive(async () => json(summarizeDevices(await backend.discover(timeoutMs ?? 500)))),
  );

  server.registerTool(
    "export_configuration",
    {
      title: "Export configuration",
      description: [
        "Read the complete persistent configuration of one Twister: globals and every encoder in every bank.",
        "Sends only read requests. Returns a snapshotId to pass to plan_changes, and the configuration itself.",
        "The configuration contains the unit ID, which is private device data; do not repeat it unnecessarily.",
      ].join(" "),
      inputSchema: z.object({ device: deviceIndex, timeoutMs }),
      annotations: readOnly,
    },
    ({ device, timeoutMs }) =>
      exclusive(async () => {
        const timeout = timeoutMs ?? 500;
        const selected = selectDevice(await backend.discover(timeout), device);
        const connection = backend.connect(selected);
        try {
          const configuration = await exportConfiguration(connection, selected, { timeoutMs: timeout });
          return json({ snapshotId: remember(configuration), configuration });
        } finally {
          connection.close();
        }
      }),
  );

  server.registerTool(
    "plan_changes",
    {
      title: "Plan configuration changes",
      description: [
        "Build a reviewable patch plan from a snapshot this server exported. Offline: opens no MIDI port and changes nothing.",
        "Each change is a semantic path and value, such as bank.1.encoder.1.colors.active = green; the skill's settings reference lists every path.",
        "Omit changes already at the desired value: one no-op rejects the whole plan.",
        "Plans expire after 15 minutes.",
      ].join(" "),
      inputSchema: z.object({
        snapshotId: z.string().describe("snapshotId returned by export_configuration."),
        changes: z
          .array(
            z.object({
              path: z.string().describe("Semantic setting path, e.g. bank.1.encoder.1.colors.active or global.brightness.rgb."),
              value: z.union([z.string(), z.number(), z.boolean()]).describe("Desired value: a palette name, number, or boolean as the path requires."),
            }),
          )
          .min(1),
      }),
      annotations: readOnly,
    },
    async ({ snapshotId, changes }) => {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) {
        throw new Error(`Unknown snapshotId ${snapshotId}. Export the configuration again; the server keeps only its ${SNAPSHOT_LIMIT} most recent snapshots, and none survive a restart.`);
      }
      return json(createPatchPlan(snapshot, changes));
    },
  );

  for (const skill of skills) {
    for (const file of skill.files) {
      const isEntry = file.uri === skill.uri;
      server.registerResource(
        isEntry ? skill.frontmatter.name : `${skill.frontmatter.name}/${file.path}`,
        file.uri,
        isEntry ? { mimeType: file.mimeType, description: skill.frontmatter.description } : { mimeType: file.mimeType },
        async () => ({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }),
      );
    }
  }

  // Every skill fits on one page, so the cursor is accepted and ignored.
  server.server.setRequestHandler("skills/list", { params: z.looseObject({ cursor: z.string().optional() }).optional() }, () => ({
    ...cacheable,
    skills: skills.map(skillEntry),
  }));
  server.server.setRequestHandler("skills/get", { params: z.looseObject({ uri: z.string() }) }, ({ uri }) => {
    const skill = skillsByUri.get(uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${uri}`);
    return { ...cacheable, skill: skillEntry(skill) };
  });

  return server;
}

export async function runMcpServer(version: string): Promise<void> {
  const { RtMidiBackend } = await import("./midi.js");
  serveStdio(createMcpServerFactory({ backend: new RtMidiBackend(), skills: await loadSkills(), version }));
}
