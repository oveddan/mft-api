# Agent skill installation

The `mft-configurator` skill lets Claude Code or Codex inspect and configure a
MIDI Fighter Twister in plain language. It drives the `mft-config` CLI; it never
talks to the device directly.

## 1. Install the CLI

```sh
npm install -g mft-config
```

The skill also works with `npx -y mft-config` if you would rather not install
anything globally.

## 2. Install the skill

No clone and no build — this fetches only the skill directory.

For Claude Code:

```sh
mkdir -p ~/.claude/skills/mft-configurator && curl -fsSL https://github.com/oveddan/mft-api/archive/refs/heads/main.tar.gz | tar -xz --strip-components=4 -C ~/.claude/skills/mft-configurator mft-api-main/.claude/skills/mft-configurator
```

For Codex, the same command with a different destination:

```sh
mkdir -p ~/.codex/skills/mft-configurator && curl -fsSL https://github.com/oveddan/mft-api/archive/refs/heads/main.tar.gz | tar -xz --strip-components=4 -C ~/.codex/skills/mft-configurator mft-api-main/.claude/skills/mft-configurator
```

Both commands overwrite in place, so re-running them upgrades. Delete the
destination directory first if you want files removed upstream to disappear too.

Working inside a checkout of this repository, Claude Code discovers the skill
automatically and neither step 2 command is needed.

## 3. Use it

Invoke `/mft-configurator` in Claude Code or `$mft-configurator` in Codex, or
just ask the agent to inspect or configure a Twister.

The skill defaults to discovery and export. Applying a configuration plan to the
controller requires a separate, explicit instruction.

## Notes

`SKILL.md` uses the portable Agent Skills format understood by both Claude Code
and Codex. The optional `agents/openai.yaml`, generated with Codex's skill
creator, adds Codex UI metadata; Claude Code ignores it.

**Run the agent from one consistent working directory.** `mft-config` writes its
backups and its single-use plan journal to `.mft-state/` relative to the current
working directory, so an `apply` run from a different directory than an earlier
one consults a different journal.

A Claude Code plugin that installs the skill and an MCP server in a single step
is planned; see [#8](https://github.com/oveddan/mft-api/issues/8) and
[#12](https://github.com/oveddan/mft-api/issues/12).
