# MIDI Fighter Twister configuration API

Read and write the persistent configuration of a DJ TechTools MIDI Fighter
Twister from the command line. The tool discovers a connected Twister over USB MIDI,
exports its complete SysEx configuration as JSON, creates reviewable offline
change plans, and safely applies supported changes back to the controller.

The protocol implementation is based on the
[official DJ TechTools MIDI Fighter Twister firmware](https://github.com/DJ-TechTools/Midi_Fighter_Twister_Open_Source).

## What the controller can do

The MIDI Fighter Twister is a banked USB MIDI controller with:

- 16 endless rotary encoders arranged in a 4×4 grid
- a push switch under every encoder
- RGB illumination and an LED position ring for every encoder
- six side buttons for MIDI, shift-page, and bank actions
- four configuration banks, with optional eight-bank firmware support
- separate MIDI mappings and visual behavior for every encoder in every bank

Turning an encoder can send notes, absolute or relative control changes, switch
velocity, or mouse-emulation messages. Pressing it can act as a momentary or
toggle CC/note button, reset its value, enable fine adjustment, or temporarily
select a shifted encoder layer. The colors, indicator style, detent, response,
MIDI channel, and MIDI number are independently configurable.

## What this tool does

- `list` discovers connected Twisters without changing them.
- `export` reads device identity, global settings, and all 64 or 128 banked
  encoder records into JSON.
- `plan` creates an offline, content-addressed description of proposed changes.
  It does not open MIDI ports.
- `apply` writes an eligible plan, saves a backup first, and reads the entire
  controller back after every changed target to verify the result.

Only `apply` can write configuration. System commands, reset commands, and
bootloader commands are always blocked. Live writes currently require firmware
`2026-07-02` and a strong command-`0x05` device identity.

## Install

Requirements:

- Node.js 20 or newer
- a native MIDI toolchain supported by `@julusian/midi`
- on Linux, the ALSA development package required by RtMidi

```sh
git clone https://github.com/oveddan/mft-api.git
cd mft-api
npm install
npm run check
```

Build the CLI after making changes:

```sh
npm run build
```

The examples below use `node dist/cli.js`. After packaging or linking the npm
binary, the equivalent command name is `mft-export`.

## Read the controller

List connected Twisters:

```sh
node dist/cli.js list
```

Export the only connected device:

```sh
node dist/cli.js export --out twister-config.json
```

If more than one Twister is connected, use the index shown by `list`:

```sh
node dist/cli.js export --device 1 --out twister-config.json
```

The JSON includes the firmware and unit identity, detected bank count, all
decoded global and encoder fields, the original raw tag values, and warnings for
unknown or incomplete firmware responses.

## Addressing knobs

Each bank contains encoders `1` through `16`, numbered left-to-right and
top-to-bottom:

```text
 1   2   3   4
 5   6   7   8
 9  10  11  12
13  14  15  16
```

A setting path has this form:

```text
bank.<bank>.encoder.<encoder>.<setting>
```

For example, `bank.1.encoder.2.switch.action.code` is the push-switch action for
the second knob in the top row of bank 1. Bank and encoder numbers are one-based.

## Settings for every encoder

Every physical knob has a rotary encoder and a push switch. Each bank gives that
pair an independent configuration.

| Setting path | Values | What it controls |
| --- | --- | --- |
| `encoder.midiChannel` | `1..16` | MIDI channel used when turning the knob |
| `encoder.shiftedMidiChannel` | `1..16` | MIDI channel used while the knob's shift layer is active |
| `encoder.midiNumber` | `0..127` | note or CC number sent by the rotary encoder |
| `encoder.type.code` | `0..5` | rotary output type; see below |
| `movement.code` | `0..2` | direct, responsive, or velocity-sensitive response |
| `switch.midiChannel` | `1..16` | MIDI channel used by the push switch |
| `switch.midiNumber` | `0..127` | note or CC number sent by the push switch |
| `switch.action.code` | `0..8` | momentary, toggle, reset, fine, or shift behavior |
| `colors.active` | name or `0..127` | RGB color while the switch is active |
| `colors.inactive` | name or `0..127` | RGB color while the switch is inactive |
| `detent.enabled` | `true` / `false` | enables the encoder's detent behavior |
| `detent.color` | name or `0..127` | RGB color used at the detent |
| `indicator.code` | `0..3` | LED-ring display style |
| `superKnobEnabled` | `true` / `false` | enables the global secondary super-knob range |

### Rotary output types

| Code | Exported name | Behavior |
| --- | --- | --- |
| `0` | `note` | sends note messages |
| `1` | `cc` | sends absolute control-change values |
| `2` | `relativeEncoder` | sends relative CC values centered around 64 |
| `3` | `switchVelocityControl` | sends CC values and also adjusts push-switch velocity |
| `4` | `mouseDrag` | relative encoder mode interpreted as mouse drag by compatible software |
| `5` | `mouseScroll` | relative encoder mode interpreted as mouse scroll by compatible software |

### Movement modes

| Code | Exported name | Behavior |
| --- | --- | --- |
| `0` | `direct` | normal one-to-one encoder response |
| `1` | `responsive` | firmware emulation/responsive response |
| `2` | `velocitySensitive` | faster turns produce larger changes |

### Push-switch actions

| Code | Exported name | Behavior |
| --- | --- | --- |
| `0` | `ccHold` | sends CC 127 while held and CC 0 when released |
| `1` | `ccToggle` | alternates CC 127 and 0 on each press |
| `2` | `noteHold` | sends note-on while held and note-off when released |
| `3` | `noteToggle` | alternates note-on and note-off on each press |
| `4` | `resetToZero` | resets the encoder to zero, or its center when detent is enabled |
| `5` | `resetToMaximum` | resets the encoder to 127, or its center when detent is enabled |
| `6` | `fineAdjust` | makes turning finer while the switch is held |
| `7` | `shiftHold` | uses the shifted encoder layer while held |
| `8` | `shiftToggle` | toggles the shifted encoder layer on and off |

### Indicator styles

| Code | Exported name |
| --- | --- |
| `0` | `dot` |
| `1` | `bar` |
| `2` | `blendedBar` |
| `3` | `spreadBar` |

## Side buttons

The six physical side buttons share the global MIDI channel. They can be banked
or unbanked, and the export identifies each button's action:

| Codes | Actions |
| --- | --- |
| `0..3` | `ccHold`, `ccToggle`, `noteHold`, `noteToggle` |
| `4..7` | `shiftPage1Hold`, `shiftPage2Hold`, `shiftPage1Toggle`, `shiftPage2Toggle` |
| `8..10` | `bankUp`, `bankDown`, `bankSelect` |
| `11..18` | direct selection of `bank1` through `bank8` |
| `19` | `cycleBank` |

`global.sideButtonsBanked` can currently be changed by the planner. Individual
side-button actions are exported but are intentionally read-only until their
write path is added and tested.

## Global settings

| Setting path | Values | Meaning |
| --- | --- | --- |
| `global.midiChannel` | `1..16` | system and side-button MIDI channel |
| `global.sideButtonsBanked` | `true` / `false` | give side buttons bank-specific MIDI numbers |
| `global.superKnob.start` | `0..127` | start of the secondary super-knob range |
| `global.superKnob.end` | `0..127` | end of the secondary super-knob range |
| `global.brightness.rgb` | `0..127` | RGB illumination brightness |
| `global.brightness.indicator` | `0..127` | LED-ring brightness |
| `global.colorMap.code` | `0` / `1` | classic or MF64 color palette |
| `global.animationChannels.encoder` | `1..16` | MIDI feedback channel for encoder-ring animation |
| `global.animationChannels.switch` | `1..16` | MIDI feedback channel for switch-color animation |
| `global.sleep.timeoutIndex` | `0..7` | timeout: 0, 1, 3, 5, 10, 20, 30, or 60 minutes |
| `global.sleep.animation.code` | `0` / `1` | lights off or rainbow-wave sleep animation |
| `global.bankAnimationsEnabled` | `true` / `false` | enables bank-change animations |

The export also reports all six side-button actions and preserves every raw
global tag, including fields that are not yet writable.

## Colors

Colors can be supplied as palette indices from `0` through `127`. The planner
also accepts these names for the palette recorded in the snapshot:

- Classic: `off`, `black`, `blue`, `green`, `yellow`, `red`, `magenta`,
  `purple`, `white`
- MF64: `off`, `black`, `white`, `red`, `orange`, `yellow`, `green`, `teal`,
  `blue`, `purple`, `magenta`, `pink`

Do not change `global.colorMap.code` and use named colors in the same plan: color
names are resolved using the palette in the input snapshot. Export a fresh
snapshot after changing palettes, then plan the color changes.

## Change configuration

Changes use a deliberate three-step workflow: export a fresh snapshot, create
and inspect an offline plan, then explicitly apply it. Plans expire after 15
minutes and are bound to the snapshot hash, firmware version, and device ID.

### Make the top row green when active and purple when inactive

```sh
node dist/cli.js export --out twister-config.json

node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.colors.active=green \
  --set bank.1.encoder.1.colors.inactive=purple \
  --set bank.1.encoder.2.colors.active=green \
  --set bank.1.encoder.2.colors.inactive=purple \
  --set bank.1.encoder.3.colors.active=green \
  --set bank.1.encoder.3.colors.inactive=purple \
  --set bank.1.encoder.4.colors.active=green \
  --set bank.1.encoder.4.colors.inactive=purple \
  --out patch-plan.json

node dist/cli.js apply --plan patch-plan.json --yes
```

### Make the first two push switches toggle on and off

Code `1` is `ccToggle`:

```sh
node dist/cli.js export --out twister-config.json

node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.switch.action.code=1 \
  --set bank.1.encoder.2.switch.action.code=1 \
  --out patch-plan.json

node dist/cli.js apply --plan patch-plan.json --yes
```

### Change a knob's rotary and push MIDI mappings

This makes bank 2, encoder 5 send CC 20 on channel 3 when turned, and a
momentary CC 40 on channel 4 when pressed:

```sh
node dist/cli.js export --out twister-config.json

node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.2.encoder.5.encoder.type.code=1 \
  --set bank.2.encoder.5.encoder.midiChannel=3 \
  --set bank.2.encoder.5.encoder.midiNumber=20 \
  --set bank.2.encoder.5.switch.action.code=0 \
  --set bank.2.encoder.5.switch.midiChannel=4 \
  --set bank.2.encoder.5.switch.midiNumber=40 \
  --out patch-plan.json

node dist/cli.js apply --plan patch-plan.json --yes
```

### Set a velocity-sensitive spread indicator with a red detent

```sh
node dist/cli.js export --out twister-config.json

node dist/cli.js plan \
  --snapshot twister-config.json \
  --set bank.3.encoder.9.movement.code=2 \
  --set bank.3.encoder.9.indicator.code=3 \
  --set bank.3.encoder.9.detent.enabled=true \
  --set bank.3.encoder.9.detent.color=red \
  --out patch-plan.json

node dist/cli.js apply --plan patch-plan.json --yes
```

### Change global brightness and sleep behavior

```sh
node dist/cli.js export --out twister-config.json

node dist/cli.js plan \
  --snapshot twister-config.json \
  --set global.brightness.rgb=96 \
  --set global.brightness.indicator=80 \
  --set global.sleep.timeoutIndex=4 \
  --set global.sleep.animation.code=0 \
  --out patch-plan.json

node dist/cli.js apply --plan patch-plan.json --yes
```

Timeout index `4` means 10 minutes; sleep animation code `0` turns the lights
off.

## Write safety

Before sending any configuration frame, `apply`:

1. validates the plan hash and expiry;
2. discovers the controller again and checks its identity and firmware;
3. takes a fresh complete snapshot and rejects stale expected values;
4. saves a timestamped JSON backup under `.mft-state/backups/`;
5. writes targets sequentially without automatic retries;
6. reads the full configuration after every target and compares it with the
   expected state; and
7. records pending, verified, failed, or unknown outcomes in an append-only
   journal.

Completed plans are single-use. See [`docs/write-safety.md`](docs/write-safety.md)
for protocol-level details and remaining limitations.

## Protocol coverage

The exporter uses Universal MIDI Identity for discovery, command `0x05` for the
2026 device ID, command `0x02` for globals, and command `0x04`/subcommand `0x01`
for encoder bulk pulls. It detects four versus eight banks with a non-mutating
encoder-tag probe and then reads all 64 or 128 encoder records sequentially.

## Current limitations

- Command `0x05` sends unencoded production-signature bytes. If a byte has its
  high bit set, the response is not valid MIDI SysEx. On macOS the exporter
  attempts to recover the identifier from the USB descriptor serial.
- Saved four-bank sequencer slots are not exposed by a firmware SysEx pull and
  cannot be exported.
- Runtime LED state, the current bank, and current encoder values are not
  persistent configuration and are not included.
- Individual side-button actions are read-only in the current planner.
- Restore is not exposed as a command yet. Backups are retained under
  `.mft-state/backups/` for a future confirmed restore workflow.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file
for the full text.
