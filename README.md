# MIDI Fighter Twister configuration tool

This prototype discovers a MIDI Fighter Twister, exports every configuration
field exposed by the firmware's SysEx protocol, and creates offline change plans.
Its guarded `apply` command can send configuration pushes only for an allowlisted,
strongly identified device; system commands, bootloader commands, and resets are
always blocked.

The SysEx protocol implemented here is based on the official
[DJ TechTools MIDI Fighter Twister firmware](https://github.com/DJ-TechTools/Midi_Fighter_Twister_Open_Source).

## Requirements

- Node.js 20 or newer
- A working native MIDI toolchain supported by `@julusian/midi`
- On Linux, the ALSA development package required by RtMidi

Install and build:

```sh
cd mft-api
npm install
npm run check
```

List connected Twisters:

```sh
npm run build
node dist/cli.js list
```

Export the only connected Twister to standard output:

```sh
node dist/cli.js export
```

Select a device and write the snapshot atomically to a file:

```sh
node dist/cli.js export --device 0 --out twister-config.json
```

Create an offline, byte-level change plan without opening MIDI ports:

```sh
node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.2.encoder.5.colors.active=red \
  --out patch-plan.json
```

Multiple `--set` options are combined into one content-addressed plan. Supported
encoder fields include MIDI channels/numbers, switch action, movement, indicator,
detent, super-knob mode, and active/inactive/detent colors. Global fields include
channels, brightness, palette, sleep, animation channels, and bank animations.

The planner is deliberately offline and cannot send MIDI. Its output binds the
change to the snapshot hash, firmware, and device ID; includes expected-old and
desired values; expires after 15 minutes; and shows every SysEx byte that a future
write command would send. See [`docs/write-safety.md`](docs/write-safety.md) for
the safeguards enforced by the live apply path and its remaining limitations.

Apply an eligible plan after reviewing its semantic diff and literal bytes:

```sh
node dist/cli.js apply --plan patch-plan.json --yes
```

Apply creates a fresh backup, rejects stale snapshots or the wrong device,
journals every frame, writes targets sequentially without retries, and compares
a complete device snapshot after every target. Currently only firmware
`2026-07-02` with a strong command-`0x05` identity is allowlisted.

The exporter discovers devices with Universal MIDI Identity, reads the 2026
device ID with command `0x05`, pulls globals with `0x02`, detects four versus
eight banks using a non-mutating encoder-tag probe, and sequentially pulls all
64 or 128 encoder records with `0x04`.

The JSON preserves raw SysEx tag values alongside normalized field names. Knob
colors appear as the persistent active, inactive, and detent palette indices;
the global color-map field identifies whether those indices use the classic or
MF64 palette.

## Scope limitations

- Command `0x05` sends unencoded production-signature bytes. If a byte has its
  high bit set, the response is not valid MIDI SysEx. On macOS the exporter
  attempts to recover the same identifier from the USB descriptor serial.
- Saved four-bank sequencer slots are not exposed by a firmware SysEx pull and
  therefore cannot be exported.
- Runtime LED state, current bank, and current encoder values are not persistent
  configuration and are not included.
- Restore is not yet exposed as a command; backups are retained under
  `.mft-state/backups/` for the forthcoming confirmed restore workflow.
