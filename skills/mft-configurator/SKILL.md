---
name: mft-configurator
description: Safely discover, inspect, export, and plan changes to a DJ TechTools MIDI Fighter Twister through the mft-config MCP server. Use for Twister device discovery, configuration exports, knob colors, push-switch modes and MIDI mappings, global settings, four- or eight-bank layouts, firmware compatibility, or reviewable change plans.
---

# MIDI Fighter Twister Configurator

Operate the Twister through the `mft-config` MCP server's tools. Treat the connected controller as user-owned hardware: inspect by default and plan a change only when the user asks for one.

The server is the whole boundary. Do not invent raw SysEx, and do not reach around the server to the device — not with another MIDI tool, and not by running the `mft-config` CLI in a shell.

## Inspect without changing the device

- `list_devices` — every connected Twister with its positional `index`, port names, and firmware date.
- `export_configuration` — the complete configuration of one Twister, plus a `snapshotId`. Pass `device` only when more than one is connected; indices follow port order and are not stable identities.

Both tools accept `timeoutMs` (default 500). Raise it when discovery misses a connected controller.

Summarize an export semantically, including:

- firmware date and identity strength;
- four versus eight banks and 16 encoders per bank;
- global MIDI, brightness, palette, animation, sleep, and side-button settings;
- each knob's encoder mapping, push-switch mapping/action, colors, detent, indicator, movement, and super-knob flag;
- all warnings.

The export contains the unit ID and the complete mapping, which are private device data. Never repeat the unit ID unnecessarily, and do not commit or publish an export.

## Plan a configuration change

Proceed only when the user explicitly asks to change settings. Before constructing paths or values, read [references/settings.md](references/settings.md).

1. Call `export_configuration` for a fresh snapshot.
2. Translate the request into the smallest set of `{ path, value }` changes. Compare with the export and omit fields already at the desired value; one no-op rejects the entire plan.
3. Call `plan_changes` with the `snapshotId` and the changes. It is offline: it opens no MIDI port.
4. Report the expected and desired values, target firmware, eligibility reasons, expiration, and affected records. A plan is not permission to write anything.

`plan_changes` plans only from snapshots the server itself exported, and it keeps only recent ones in memory. If it reports an unknown `snapshotId`, export again. Plans expire after 15 minutes; if one expired or the device may have changed, re-export and re-plan.

## Writing is not available

The server cannot write settings to the controller. Writes are disabled while the defects in [issue #14](https://github.com/oveddan/mft-api/issues/14) are open.

When a user asks to change settings: still export, still plan, still report the plan. Then tell them the change cannot be written from here yet, name the issue, and offer the vendor MIDI Fighter Utility as the way to make it by hand. Do not look for a way around this — not through the CLI, and not through an environment variable.

If a request falls outside the supported plan paths, explain the limitation. Modify the implementation only when the user separately asks for software development; do not improvise bytes against hardware.

## Answer capability questions

Read [references/settings.md](references/settings.md) when explaining colors, switch states, MIDI mappings, globals, or bank addressing. Distinguish persistent configuration from runtime LED state, the current bank, and current encoder values, which are not exported.
