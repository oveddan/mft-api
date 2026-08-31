# Agent skill installation

The `mft-configurator` skill lets Claude Code or Codex inspect and configure a
MIDI Fighter Twister in plain language. It drives the `mft-config` CLI; it never
talks to the device directly.

No clone and no build is required for any path below.

## Claude Code: install the plugin

```sh
/plugin marketplace add oveddan/mft-api
/plugin install mft-configurator@mft-api
```

The plugin bundles the skill. `/plugin update` upgrades it, and
`/plugin uninstall mft-configurator@mft-api` removes it.

Working inside a checkout of this repository, Claude Code discovers the skill
from `.claude/skills/` automatically and the plugin is unnecessary.

## Codex: fetch the skill directory

There is no marketplace equivalent, so this is a single command rather than
pretending parity exists. It fetches only the skill directory:

```sh
mkdir -p ~/.codex/skills/mft-configurator && curl -fsSL https://github.com/oveddan/mft-api/archive/refs/heads/main.tar.gz | tar -xz --strip-components=4 -C ~/.codex/skills/mft-configurator mft-api-main/.claude/skills/mft-configurator
```

It overwrites in place, so re-running it upgrades. Delete the destination
directory first if you want files removed upstream to disappear too.

The same command with `~/.claude/skills/mft-configurator` as the destination
still works for Claude Code, if you would rather not use the plugin.

## The CLI

The skill invokes `npx -y mft-config` when the command is not on `PATH`, so
this is optional. Installing it globally removes the npx startup cost from
every command:

```sh
npm install -g mft-config
```

## Use it

Invoke `/mft-configurator` in Claude Code or `$mft-configurator` in Codex, or
just ask the agent to inspect or configure a Twister.

The skill defaults to discovery and export. Applying a configuration plan to the
controller requires a separate, explicit instruction.

## Notes

`SKILL.md` uses the portable Agent Skills format understood by both Claude Code
and Codex. The optional `agents/openai.yaml`, generated with Codex's skill
creator, adds Codex UI metadata; Claude Code ignores it. Both the plugin and the
Codex one-liner serve the same single copy of the skill in `.claude/skills/`, so
there is no second copy to keep in sync.

**Run the agent from one consistent working directory.** `mft-config` writes its
backups and its single-use plan journal to `.mft-state/` relative to the current
working directory, so an `apply` run from a different directory than an earlier
one consults a different journal.

An MCP server, so that one install serves any agent that speaks the protocol
rather than one skill copy per tool, is still open; see
[#12](https://github.com/oveddan/mft-api/issues/12).
