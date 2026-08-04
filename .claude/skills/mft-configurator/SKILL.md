---
name: mft-configurator
description: Safely discover, inspect, export, and explicitly configure a DJ TechTools MIDI Fighter Twister through the mft-api CLI. Use for Twister device discovery, JSON configuration exports, knob colors, push-switch modes and MIDI mappings, global settings, four- or eight-bank layouts, firmware compatibility, or guarded plan/apply changes.
---

# MIDI Fighter Twister Configurator

Operate the repository's `mft-export` CLI from its repository root. Treat the connected controller as user-owned hardware: inspect by default and mutate only after explicit authorization.

## Prepare the CLI

1. Locate the `mft-api` checkout and `cd` to its root. If its location is unknown, ask the user; do not run from an arbitrary directory.
2. Confirm the repository with `git status -sb` and `npm pkg get name`; expect `@djtechtools/mft-export`.
3. Run `npm ci` only when dependencies are absent or stale.
4. Run `npm run build` before using `node dist/cli.js`.
5. Use only the exact ignored artifact names `twister-config.json` and `patch-plan.json`. The unit ID and complete mapping in a snapshot are private device data.
6. Check `git status -sb` after operating the device; keep `dist/`, both artifacts, and `.mft-state/` uncommitted.

Running from the repository root is safety-critical: `.mft-state/` backups and the single-use plan journal are relative to the current working directory.

Do not invent raw SysEx or bypass `src/protocol.ts`, `src/planner.ts`, or `src/applier.ts`.

## Inspect without changing the device

Use only these commands for read-only requests:

```sh
node dist/cli.js list
node dist/cli.js export --device 0 --out twister-config.json
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
node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.colors.active=green \
  --out patch-plan.json
```

4. Inspect the plan. Report the expected and desired values, target unit/firmware, eligibility reasons, expiration, and affected records. Do not treat a generated plan as permission to apply it.

Plans expire after 15 minutes. If the plan expired or the device may have changed since export, re-export and re-plan. Never edit a plan file: its ID is a content hash.

## Apply only with explicit confirmation

Require an explicit user instruction to apply the reviewed plan to the physical controller. Do not apply a plan created for a merely hypothetical request. Before confirmation, disclose that the CLI has no restore command: its backup JSON is a record, not an automated recovery path. A failed or unknown apply may require the vendor Twister Utility or manual reconfiguration.

```sh
node dist/cli.js list --timeout 1500
node dist/cli.js apply --plan patch-plan.json --yes --device 0 --timeout 1500
```

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
