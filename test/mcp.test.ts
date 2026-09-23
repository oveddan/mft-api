import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createMcpServerFactory } from "../src/mcp.js";
import type { MidiBackend } from "../src/midi.js";
import type { DeviceDescriptor } from "../src/model.js";
import { parseFrontmatter, loadSkills, SKILLS_EXTENSION } from "../src/skills.js";
import { device, FakeWritableTwister } from "./fake-twister.js";

const SkillEntry = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }).passthrough(),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
});
// No `resultType` here: the v2 client consumes it as a protocol-level field
// before a result reaches the caller. The wire-level test below checks it.
const ListSkillsResult = z.object({ skills: z.array(SkillEntry), ttlMs: z.number(), cacheScope: z.string() });
const GetSkillResult = z.object({ skill: SkillEntry, ttlMs: z.number(), cacheScope: z.string() });

class FakeBackend implements MidiBackend {
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly devices: DeviceDescriptor[] = [device]) {}

  async discover(): Promise<DeviceDescriptor[]> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight -= 1;
    return this.devices;
  }

  connect(): FakeWritableTwister {
    return new FakeWritableTwister();
  }

  connectForApply(): never {
    throw new Error("The MCP server must never open a write connection");
  }
}

async function connect(backend: MidiBackend = new FakeBackend()): Promise<Client> {
  const server = createMcpServerFactory({ backend, skills: await loadSkills(), version: "0.0.0-test" })();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first!.text;
}

test("offers only read and offline-plan tools, all annotated read-only", async () => {
  const client = await connect();
  const { tools } = await client.listTools();

  // A write tool must arrive deliberately with the issue 14 fixes, not slip in.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["export_configuration", "list_devices", "plan_changes"]);
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
});

test("exports a configuration and plans against its snapshotId", async () => {
  const client = await connect();
  const exported = JSON.parse(text(await client.callTool({ name: "export_configuration", arguments: {} }))) as {
    snapshotId: string;
    configuration: { banks: unknown[] };
  };
  assert.match(exported.snapshotId, /^[0-9a-f]{64}$/);
  assert.equal(exported.configuration.banks.length, 4);

  const result = await client.callTool({
    name: "plan_changes",
    arguments: { snapshotId: exported.snapshotId, changes: [{ path: "bank.1.encoder.1.colors.active", value: "green" }] },
  });
  assert.equal(result.isError, undefined);
  const plan = JSON.parse(text(result)) as { planId: string; snapshotHash: string; changes: unknown[] };
  assert.match(plan.planId, /^sha256:/);
  assert.equal(plan.changes.length, 1);
});

test("plans only from snapshots the server exported itself", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "plan_changes",
    arguments: { snapshotId: "0".repeat(64), changes: [{ path: "bank.1.encoder.1.colors.active", value: "green" }] },
  });

  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown snapshotId/);
});

test("refuses to guess between several connected Twisters", async () => {
  const second = { ...device, inputPort: { index: 1, name: "Twister 2" }, outputPort: { index: 1, name: "Twister 2" } };
  const client = await connect(new FakeBackend([device, second]));
  const result = await client.callTool({ name: "export_configuration", arguments: {} });

  assert.equal(result.isError, true);
  assert.match(text(result), /Found 2 devices; select one with the device argument/);
});

test("runs device operations one at a time", async () => {
  const backend = new FakeBackend();
  const client = await connect(backend);
  await Promise.all([
    client.callTool({ name: "list_devices", arguments: {} }),
    client.callTool({ name: "export_configuration", arguments: {} }),
    client.callTool({ name: "list_devices", arguments: {} }),
  ]);

  assert.equal(backend.maxInFlight, 1);
});

test("declares the skills extension and lists the skill with digests of the served bytes", async () => {
  const client = await connect();
  assert.deepEqual(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION], {});

  const listing = await client.request({ method: "skills/list", params: {} }, ListSkillsResult);
  const skill = listing.skills.find((entry) => entry.frontmatter.name === "mft-configurator");
  assert.ok(skill);
  assert.equal(skill.uri, "skill://mft-configurator/SKILL.md");
  assert.ok(skill.resources.some((resource) => resource.uri === skill.uri));
  assert.ok(skill.resources.some((resource) => resource.uri === "skill://mft-configurator/references/settings.md"));

  // A host verifies every read against the manifest, so a mismatch here is a
  // skill no conforming host will load.
  for (const resource of skill.resources) {
    const read = await client.readResource({ uri: resource.uri });
    const bytes = Buffer.from((read.contents[0] as { text: string }).text, "utf8");
    assert.equal(bytes.length, resource.size, resource.uri);
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, resource.digest, resource.uri);
  }

  const got = await client.request({ method: "skills/get", params: { uri: skill.uri } }, GetSkillResult);
  assert.deepEqual(got.skill, skill);
});

test("skills/get rejects a URI that is not a served skill with Invalid params", async () => {
  const client = await connect();
  await assert.rejects(
    client.request({ method: "skills/get", params: { uri: "skill://mft-configurator/references/settings.md" } }, GetSkillResult),
    (error: { code?: number }) => error.code === -32602,
  );
});

test("the server instructions point at the skill", async () => {
  const client = await connect();
  assert.match(client.getInstructions() ?? "", /skill:\/\/mft-configurator\/SKILL\.md/);
});

test("frontmatter the parser cannot render verbatim is refused rather than approximated", () => {
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: b: c\n---\nbody"), { name: "a", description: "b: c" });
  assert.throws(() => parseFrontmatter("---\nname: a\ndescription: b\nmetadata:\n  key: value\n---\n"), /Unsupported/);
  assert.throws(() => parseFrontmatter("---\nname: a\ndescription: \"quoted\"\n---\n"), /Unsupported/);
  assert.throws(() => parseFrontmatter("# no frontmatter"), /must begin/);
});

test("skills/list and skills/get carry resultType, ttlMs, and cacheScope on the wire", async () => {
  // The extension requires all three on both results, and an SDK client strips
  // resultType before returning a result, so read the raw stdio stream instead.
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", cli, "mcp"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  const results = new Map<number, Record<string, unknown>>();
  const done = new Promise<void>((resolve, reject) => {
    let buffer = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; result?: Record<string, unknown> };
        buffer = buffer.slice(newline + 1);
        if (message.id === undefined || !message.result) continue;
        results.set(message.id, message.result);
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "skills/list", params: {} });
          send({ jsonrpc: "2.0", id: 3, method: "skills/get", params: { uri: "skill://mft-configurator/SKILL.md" } });
        }
        if (results.has(2) && results.has(3)) resolve();
      }
    });
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "wire", version: "0" } } });
  try {
    await done;
  } finally {
    child.kill();
  }

  for (const id of [2, 3]) {
    const result = results.get(id)!;
    assert.equal(result.resultType, "complete");
    assert.equal(typeof result.ttlMs, "number");
    assert.equal(result.cacheScope, "public");
  }
});

// Any stray write to stdout corrupts the protocol stream, so these drive the
// real entry point rather than the in-process server. The two cases are the two
// protocol eras: the 2025 `initialize` handshake most hosts speak today, and
// the 2026-07-28 `server/discover` handshake the Skills Extension targets.
for (const [era, mode, expectedVersion] of [
  ["2025", "legacy", "2025-11-25"],
  ["2026-07-28", { pin: "2026-07-28" }, "2026-07-28"],
] as const) {
  test(`mft-config mcp serves the ${era} protocol over stdio with the skills extension declared`, async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode } });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", cli, "mcp"], cwd: fileURLToPath(new URL("..", import.meta.url)), stderr: "pipe" }),
    );
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), expectedVersion);
      assert.equal(client.getServerVersion()?.name, "mft-config");
      assert.deepEqual(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION], {});
      const { tools } = await client.listTools();
      assert.equal(tools.length, 3);
      const listing = await client.request({ method: "skills/list", params: {} }, ListSkillsResult);
      assert.deepEqual(
        listing.skills.map((skill) => skill.uri),
        ["skill://mft-configurator/SKILL.md"],
      );
    } finally {
      await client.close();
    }
  });
}
