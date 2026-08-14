---
name: mft-configurator
description: Safely discover, inspect, export, and explicitly configure a DJ TechTools MIDI Fighter Twister through the mft-api CLI. Use for Twister device discovery, JSON configuration exports, knob colors, push-switch modes and MIDI mappings, global settings, four- or eight-bank layouts, firmware compatibility, or guarded plan/apply changes.
---

# MIDI Fighter Twister Configurator

Operate the `mft-config` CLI. Treat the connected controller as user-owned hardware: inspect by default and mutate only after explicit authorization.

## Prepare the CLI

The CLI is published to npm. No checkout, no build.

1. Prefer an installed `mft-config` on `PATH`. Check with `mft-config --help`.
2. If it is absent, use `npx -y mft-config …` in its place throughout this skill. Do not clone or build the repository to obtain it.

**Pick one working directory and stay in it.** This is safety-critical and easy
to get wrong now that there is no repository root to anchor to:

- `.mft-state/` — the write backups and the **single-use plan journal** — is
  created relative to the current working directory.
- Running `apply` from a different directory than a previous `apply` consults a
  *different journal*, which silently defeats the single-use guarantee that
  stops a plan from being replayed.
- So: ask the user for a working directory once, `cd` there, and run every
  `export`, `plan`, and `apply` from that same directory for the whole session.
  If you cannot establish one, say so rather than guessing.

Use only the artifact names `twister-config.json` and `patch-plan.json`. The
unit ID and complete mapping in a snapshot are private device data — do not
commit, publish, or paste them.

Do not invent raw SysEx, and do not reach around the CLI to the device. The
`plan` and `apply` commands are the entire write boundary.

## Inspect without changing the device

Use only these commands for read-only requests:

```sh
mft-config list
mft-config export --device 0 --out twister-config.json
```

Omit `--device 0` only when exactly one Twister is connected. Device indices reflect current port order, not stable identity. Use `--timeout <milliseconds>` when the default 500 ms is too short.

Summarize the export semantically, including:

- firmware date and identity strength;
- four versus eight banks and 16 encoders per bank;
- global MIDI, brightness, palette, animation, sleep, and side-button settings;
- each knob's encoder mapping, push-switch mapping/action, colors, detent, indicator, movement, and super-knob flag;
- all warnings.

Never expose a unit ID unnecessarily. Do not commit or publish an exported configuration.

## Propose a configuration change

Proceed only when the user explicitly asks to change settings. Before constructing paths or values, read [references/settings.md](references/settings.md).

1. Export a fresh complete snapshot.
2. Translate the request into the smallest set of supported `--set path=value` operations. Compare with the snapshot and omit fields already at the desired value; one no-op aborts the entire plan.
3. Create a plan offline; this does not open MIDI ports:

```sh
mft-config plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.colors.active=green \
  --out patch-plan.json
```

4. Inspect the plan. Report the expected and desired values, target unit/firmware, eligibility reasons, expiration, and affected records. Do not treat a generated plan as permission to apply it.

Plans expire after 15 minutes. If the plan expired or the device may have changed since export, re-export and re-plan. Never edit a plan file: its ID is a content hash.

## Apply is currently disabled

`mft-config apply` refuses in the current release while the write-path defects in
[issue #14](https://github.com/oveddan/mft-api/issues/14) are open — a plan file edited to set `applyEligibility.eligible=true` keeps a valid plan ID and bypasses the firmware allowlist, and `.mft-state` resolves against the current working directory.

When a user asks to change settings: still export, still plan, still report the plan. Then tell them the change cannot be written yet, name the issue, and offer the vendor MIDI Fighter Utility as the way to make it by hand. Do not look for a way around the block — there is an environment variable that lifts it and it is deliberately not for agent use.

The rest of this section describes the flow that returns once #14 lands. Keep following it for everything up to the write.

```sh
mft-config list --timeout 1500
mft-config apply --plan patch-plan.json --yes --device 0 --timeout 1500   # refuses today
```

Require an explicit user instruction to apply the reviewed plan to the physical controller. Do not apply a plan created for a merely hypothetical request. Before confirmation, disclose that the CLI has no restore command: its backup JSON is a record, not an automated recovery path. A failed or unknown apply may require the vendor Twister Utility or manual reconfiguration.

Preserve these invariants:

- Apply only an eligible, unexpired plan bound to the freshly discovered unit and snapshot.
- Re-run `list` immediately before apply and select the current positional device index. For export, verify that `device.unitId` identifies the intended controller; apply performs its own binding check.
- Accept live writes only for the exact firmware allowlist enforced by the CLI. Never weaken or work around firmware gating.
- Let the CLI create its backup, journal each sequential non-retried write, and perform complete readback verification.
- Stop on stale state, identity mismatch, timeout, `failed`, or `unknown`. Never retry a write or restore automatically; a readback timeout may mean the write landed.
- Report the backup and verified snapshot paths without printing sensitive contents.
- Never send or enable system, reset, factory-reset, bootloader, arbitrary MIDI, or arbitrary SysEx commands. Configuration push commands are the entire write boundary.

If a request falls outside supported plan paths, explain the limitation. Modify the implementation only when the user separately asks for software development; do not improvise bytes against hardware.

## Answer capability questions

Read [references/settings.md](references/settings.md) when explaining colors, switch states, MIDI mappings, globals, or bank addressing. Distinguish persistent configuration from runtime LED state, the current bank, and current encoder values, which are not exported.
