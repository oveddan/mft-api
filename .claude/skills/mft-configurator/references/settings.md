# Supported settings

Use these semantic paths with `plan --set path=value`. Banks and encoders are one-based. Each bank contains encoders 1–16. Firmware `2026-07-02` supports non-mutating detection of four versus eight banks; legacy firmware is treated as four-bank.

## Encoder fields

| Path suffix | Values |
| --- | --- |
| `detent.enabled` | `true` or `false` |
| `movement.code` | `0` direct, `1` responsive, `2` velocity-sensitive |
| `switch.action.code` | `0` CC hold, `1` CC toggle, `2` note hold, `3` note toggle, `4` reset to zero, `5` reset to maximum, `6` fine adjust, `7` shift hold, `8` shift toggle |
| `switch.midiChannel` | 1–16 |
| `switch.midiNumber` | 0–127 CC or note number |
| `encoder.midiChannel` | 1–16 |
| `encoder.shiftedMidiChannel` | 1–16 |
| `encoder.midiNumber` | 0–127 CC or note number |
| `encoder.type.code` | `0` note, `1` CC, `2` relative encoder, `3` switch velocity control, `4` mouse drag, `5` mouse scroll |
| `colors.active` | palette name or 0–127 |
| `colors.inactive` | palette name or 0–127 |
| `detent.color` | palette name or 0–127 |
| `indicator.code` | `0` dot, `1` bar, `2` blended bar, `3` spread bar |
| `superKnobEnabled` | `true` or `false` |

Build a complete path as `bank.<bank>.encoder.<encoder>.<suffix>`, for example `bank.1.encoder.2.switch.action.code`.

The switch action determines whether a press is momentary (`ccHold` or `noteHold`) or latched (`ccToggle` or `noteToggle`). Its MIDI channel and number are independent from the rotary encoder's mapping.

## Colors

The snapshot's `globals.colorMap.name` selects the palette.

- Classic: `off`/`black` 0, `blue` 1, `green` 43, `yellow` 64, `red` 85, `magenta`/`purple` 107, `white` 127.
- MF64: `off`/`black` 0, `white` 3, `red` 5, `orange` 9, `yellow` 13, `green` 21, `teal` 33, `blue` 45, `purple` 49, `magenta` 53, `pink` 57.

Named colors resolve through the active palette. Numeric indices 0–127 are accepted when an exact hardware color is required.

Changing `global.colorMap.code` reinterprets every stored color index and can recolor the entire controller. Never combine a palette change and named color changes in one plan: names resolve against the snapshot's old palette. Apply the palette change alone, re-export, and then plan colors against the new palette.

Example: make the top row of bank 1 green while active and purple while inactive:

```sh
node dist/cli.js plan --snapshot twister-config.json \
  --set bank.1.encoder.1.colors.active=green \
  --set bank.1.encoder.1.colors.inactive=purple \
  --set bank.1.encoder.2.colors.active=green \
  --set bank.1.encoder.2.colors.inactive=purple \
  --set bank.1.encoder.3.colors.active=green \
  --set bank.1.encoder.3.colors.inactive=purple \
  --set bank.1.encoder.4.colors.active=green \
  --set bank.1.encoder.4.colors.inactive=purple \
  --out patch-plan.json
```

## Global fields

| Path | Values |
| --- | --- |
| `global.midiChannel` | 1–16 |
| `global.sideButtonsBanked` | `true` or `false` |
| `global.superKnob.start` | 0–127 |
| `global.superKnob.end` | 0–127 |
| `global.brightness.rgb` | 0–127 |
| `global.brightness.indicator` | 0–127 |
| `global.colorMap.code` | `0` classic, `1` MF64 |
| `global.animationChannels.encoder` | 1–16 |
| `global.animationChannels.switch` | 1–16 |
| `global.sleep.timeoutIndex` | `0` off, `1` 1 min, `2` 3 min, `3` 5 min, `4` 10 min, `5` 20 min, `6` 30 min, `7` 60 min |
| `global.sleep.animation.code` | `0` lights off, `1` rainbow wave |
| `global.bankAnimationsEnabled` | `true` or `false` |

Side-button actions are exported but are not currently supported planner paths. Do not claim they can be changed with this CLI.

## Common plans

Make push switches 1 and 2 in bank 1 toggle CC values:

```sh
node dist/cli.js plan --snapshot twister-config.json \
  --set bank.1.encoder.1.switch.action.code=1 \
  --set bank.1.encoder.2.switch.action.code=1 \
  --out patch-plan.json
```

Map bank 2 encoder 5 rotation to CC 74 on channel 3 and its push to note 60 on channel 10:

```sh
node dist/cli.js plan --snapshot twister-config.json \
  --set bank.2.encoder.5.encoder.type.code=1 \
  --set bank.2.encoder.5.encoder.midiChannel=3 \
  --set bank.2.encoder.5.encoder.midiNumber=74 \
  --set bank.2.encoder.5.switch.action.code=2 \
  --set bank.2.encoder.5.switch.midiChannel=10 \
  --set bank.2.encoder.5.switch.midiNumber=60 \
  --out patch-plan.json
```

The planner rejects no-op values. If one field already has the requested value, omit that `--set` and plan only the remaining changes.

## Firmware and export boundaries

- Discovery/export supports legacy profiles and the audited 2026 protocol, including command `0x05` and expanded global tags. Eight-bank probing is available on firmware `2026-07-02`.
- Live apply requires firmware `2026-07-02` and a strong unit identity. Firmware newer than `2026-07-02` is rejected by export and apply until audited and allowlisted; `list` can still report its identity.
- The export preserves all reported raw tags alongside normalized fields.
- Saved sequencer slots, runtime LED state, current bank, and current encoder values are not part of the persistent export.
