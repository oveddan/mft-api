# Agent skill installation

The canonical `mft-configurator` skill lives at
[`../.claude/skills/mft-configurator`](../.claude/skills/mft-configurator).
Claude Code discovers it automatically when working in this checkout. Its
`SKILL.md` uses the portable Agent Skills format understood by both Claude Code
and Codex. The optional `agents/openai.yaml` file, generated with Codex's skill
creator, adds Codex UI metadata; Claude Code ignores it.

Install it globally for Claude Code when it should be available outside this
checkout:

```sh
mkdir -p ~/.claude/skills
cp -R .claude/skills/mft-configurator ~/.claude/skills/
```

Install a copy for Codex:

```sh
mkdir -p ~/.codex/skills
cp -R .claude/skills/mft-configurator ~/.codex/skills/
```

Replace an older installed copy before upgrading so files removed upstream do
not linger. After installation, invoke `/mft-configurator` in Claude Code or
`$mft-configurator` in Codex, or ask the agent to inspect or configure a MIDI
Fighter Twister. The skill defaults to discovery and export. It requires a
separate, explicit instruction before applying a reviewed configuration plan to
the controller.
