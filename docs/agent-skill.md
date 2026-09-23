# Agents: the MCP server and its skill

Agents reach the Twister through `mft-config mcp`, a Model Context Protocol
server on stdio. It is the primary interface for agents; the CLI remains for
people running one-off commands.

The server needs Node.js 20 or newer and nothing else. There is no clone, no
build, and no standalone binary.

## Install

Claude Code (`-s user` makes it available in every project, not just the
current directory):

```sh
claude mcp add -s user mft-config -- npx -y mft-config mcp
```

Codex:

```sh
codex mcp add mft-config -- npx -y mft-config mcp
```

`npx -y` fetches the latest published version when the server starts. For a
faster start, `npm install -g mft-config` and register `mft-config mcp` instead.

## Tools

| Tool | Does | Touches the device |
| --- | --- | --- |
| `list_devices` | Discovers Twisters by Universal Identity request | Read requests only |
| `export_configuration` | Reads the full configuration; returns it and a `snapshotId` | Read requests only |
| `plan_changes` | Builds a patch plan from a `snapshotId` and `{ path, value }` changes | No — offline |

There is **no write tool**. Writing is disabled while the defects in
[#14](https://github.com/oveddan/mft-api/issues/14) are open, and a server tool
would widen that boundary. When writing returns, it is intended to take a plan
ID the server created — never plan JSON from the agent — per invariant 9 in
[write-safety.md](write-safety.md).

`plan_changes` plans only from a snapshot the server exported itself. The agent
never supplies configuration to plan from, so a plan cannot be built against a
fabricated device state. The server keeps its 16 most recent snapshots in
memory; none survive a restart.

## The skill is served by the server

The server implements the MCP Skills Extension
([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640),
`io.modelcontextprotocol/skills`):

- it declares the extension in its capabilities;
- every file of [`skills/mft-configurator/`](../skills/mft-configurator) is a
  resource under `skill://mft-configurator/…`;
- `skills/list` and `skills/get` return the skill's frontmatter and a manifest
  of every file with its SHA-256 digest and size, computed from the exact bytes
  the server serves.

`skills/` in the npm package is the single copy. The Claude Code plugin and the
Codex `curl | tar` install that used to distribute it are gone, so there is
nothing to keep in sync with the server.

A host that does not implement the extension still gets the skill: the server's
instructions name `skill://mft-configurator/SKILL.md`, which is an ordinary
readable resource.

The extension is specified against MCP revision 2026-07-28, where a server
declares it through `server/discover`. The server is built on the v2 TypeScript
SDK, which serves that revision and the 2025 `initialize` handshake from the
same code, so the declaration is visible on either. No SDK implements the
extension itself yet, so `skills/list` and `skills/get` are registered here as
custom methods.

As of September 2026 the extension's own implementation list does not name
Claude Code or Codex as hosts. Until they support it, the instructions pointer
above is how those agents find the skill.

## MIDI ports are not held between calls

Each tool call discovers the controller, opens its ports, and closes them
before returning — exactly what one CLI invocation does. The server therefore
contends with a DAW or the vendor MIDI Fighter Utility for the port no more than
the CLI already does.

Holding the port open was the main argument for a long-running process, and it
was rejected for that reason. On Windows a MIDI port is exclusive, so a server
that kept it would lock a DAW out for as long as the agent session lasted. On
macOS CoreMIDI shares ports, but the server would then be listening to
performance traffic it has no use for. Discovery costs about `timeoutMs` per
MIDI output, which is small next to an agent's turn.

Device operations within one server run one at a time, since two discoveries
probing every port at once would read each other's identity replies. Two
separate servers, or the server and the CLI, are not coordinated; see
[write-safety.md](write-safety.md#one-writer-at-a-time).

## Why not a standalone binary

Considered in [#12](https://github.com/oveddan/mft-api/issues/12) and rejected.
Requiring Node is acceptable for this audience, and a single-file executable
would have to carry the native MIDI addon for every platform plus macOS signing
and notarization, for a user who already has Node in nearly every case.
