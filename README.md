# MIDI Fighter Twister configuration API

Read and write the persistent configuration of a DJ TechTools MIDI Fighter Twister —
so an agent can set it up for you from a chat interface instead of you clicking through
sixteen knobs by hand.

<!-- IMAGE 1 (hero): photo of the Twister lit with a deliberate color layout —
     e.g. top three rows one color, bottom row another. Shows the hardware and the
     exact thing that is tedious to do by hand, in one frame.
     Suggested path: docs/images/twister-hero.jpg -->

![The MIDI Fighter Twister with a color layout applied](docs/images/twister-hero.jpg)

## The problem

It's a great controller because it's super programmable. You can change the MIDI CC
values of every knob. You can change the colors. You can send values back to it to turn
the knobs — so it's a bidirectional controller.

But if you want to program it and map it to Ableton or Chromatik or TouchDesigner, it
takes a few steps.

First, you have to go into the UI and click on every single knob, one by one, to see
what its MIDI CC value is. If you want to change a color, you set that up one by one
too. It's hard to set a bunch of knobs' colors at once — let's say you want the top
three rows to be the same color. Same with the button settings: trigger, latch, all the
different button settings, you have to go one by one.

The other thing is, let's say you have the program you're linking it with — Ableton,
your music program, or TouchDesigner, or Chromatik. You then have to look in that
program and manually reconcile what each MIDI CC value goes to. You have to manually map
it, and you have to go back and forth between the two.

<!-- IMAGE 2 (before/after): left — the stock Twister editor with a single knob
     selected, showing what clicking through 16 knobs looks like. Right — the one
     sentence that replaces it. Makes the tedium concrete for a reader who has never
     opened the editor.
     Suggested path: docs/images/before-after.png -->

![The stock editor, one knob at a time, next to the sentence that replaces it](docs/images/before-after.png)

## What this changes

Now, with a single chat interface via agentic tools, you can just chat how you want it
to be connected. You can say: I want this top knob to control intensity in
TouchDesigner, or in these patterns. Or: I want this knob, when you press it, to trigger
an instrument or a visual effect. And it'll do both the mapping and the color — you
describe what color you want it to be — and it does all that in one shot.

<!-- IMAGE 3 (the demo): short GIF or video — type a sentence, physical knobs change
     color or turn. The bidirectional behavior is the least obvious property of this
     device and the only way to convey it is to show it.
     Suggested path: docs/images/chat-to-knobs.gif -->

![Typing a sentence; the knobs change](docs/images/chat-to-knobs.gif)

## Example: mapping a controller I didn't have

This is how I actually used it in Chromatik. Someone had mapped a controller. I didn't
have that controller on me, I had the MIDI Fighter Twister. I was able to say: look at
how this controller is mapped, explain to me how it works. It was able to understand it.
Then it was able to understand how the MIDI Fighter Twister works and suggest a few
different possible sets of mappings for me, and I was able to choose one. Super easy.
That would have taken me a very long time to do manually.

<!-- IMAGE 4 (transcript): the actual chat exchange from that Chromatik session, as a
     screenshot or a fenced block. This is the strongest single asset in the README —
     it is a thing that happened rather than a claim about what is possible.
     Suggested path: docs/images/chromatik-mapping-chat.png -->

![The chat exchange that produced the mapping](docs/images/chromatik-mapping-chat.png)

Underneath, the agent is driving the CLI documented below. Nothing is hidden — the same
work by hand looks like this:

```sh
mft-config export --out twister-config.json

mft-config plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.colors.active=green \
  --set bank.1.encoder.1.colors.inactive=purple \
  --out patch-plan.json

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
```

## What this is not

This isn't meant to replace the artist. This is meant to help the creator or the artist
do things a lot faster, without having to deal with user interfaces or clunky
back-and-forth. You describe what you want and it gets done for you. So you can get to
creating, instead of having to worry about the tech.

---

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

> **`apply` is disabled in the current release.** Two defects in the write path
> ([#14](https://github.com/oveddan/mft-api/issues/14)) are open: a plan file
> edited to set `applyEligibility.eligible=true` keeps a valid plan ID, which
> bypasses the firmware allowlist; and `.mft-state` — the backups and the
> single-use plan journal — resolves against the current working directory, so
> applying from a different directory consults a different journal. That second
> one became easy to hit once the CLI could be installed and run from anywhere.
>
> `list`, `export`, and `plan` are unaffected and are the whole read path. To
> write settings meanwhile, use the vendor MIDI Fighter Utility.

## Install

Requires Node.js 20 or newer. Prebuilt MIDI binaries ship for macOS, Windows,
and Linux, so no compiler is needed on common platforms.

```sh
npm install -g mft-config
```

Or run it without installing anything:

```sh
npx -y mft-config list
```

Every example below uses `mft-config`. The old `mft-export` name still works as
a deprecated alias and will be removed in a future release.

**Run every command from the same directory.** `mft-config` writes its backups
and its single-use plan journal to `.mft-state/` relative to the current working
directory, so switching directories between `plan` and `apply` consults a
different journal. Pick a directory and stay in it.

## Read the controller

List connected Twisters:

```sh
mft-config list
```

Export the only connected device:

```sh
mft-config export --out twister-config.json
```

If more than one Twister is connected, use the index shown by `list`:

```sh
mft-config export --device 1 --out twister-config.json
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

**The third step is disabled in this release** — see the note under [What this
tool does](#what-this-tool-does). The recipes below still work through `plan`,
which is offline and never opens a MIDI port; only the final `apply` refuses.

### Make the top row green when active and purple when inactive

```sh
mft-config export --out twister-config.json

mft-config plan \
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

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
```

### Make the first two push switches toggle on and off

Code `1` is `ccToggle`:

```sh
mft-config export --out twister-config.json

mft-config plan \
  --snapshot twister-config.json \
  --set bank.1.encoder.1.switch.action.code=1 \
  --set bank.1.encoder.2.switch.action.code=1 \
  --out patch-plan.json

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
```

### Change a knob's rotary and push MIDI mappings

This makes bank 2, encoder 5 send CC 20 on channel 3 when turned, and a
momentary CC 40 on channel 4 when pressed:

```sh
mft-config export --out twister-config.json

mft-config plan \
  --snapshot twister-config.json \
  --set bank.2.encoder.5.encoder.type.code=1 \
  --set bank.2.encoder.5.encoder.midiChannel=3 \
  --set bank.2.encoder.5.encoder.midiNumber=20 \
  --set bank.2.encoder.5.switch.action.code=0 \
  --set bank.2.encoder.5.switch.midiChannel=4 \
  --set bank.2.encoder.5.switch.midiNumber=40 \
  --out patch-plan.json

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
```

### Set a velocity-sensitive spread indicator with a red detent

```sh
mft-config export --out twister-config.json

mft-config plan \
  --snapshot twister-config.json \
  --set bank.3.encoder.9.movement.code=2 \
  --set bank.3.encoder.9.indicator.code=3 \
  --set bank.3.encoder.9.detent.enabled=true \
  --set bank.3.encoder.9.detent.color=red \
  --out patch-plan.json

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
```

### Change global brightness and sleep behavior

```sh
mft-config export --out twister-config.json

mft-config plan \
  --snapshot twister-config.json \
  --set global.brightness.rgb=96 \
  --set global.brightness.indicator=80 \
  --set global.sleep.timeoutIndex=4 \
  --set global.sleep.animation.code=0 \
  --out patch-plan.json

mft-config apply --plan patch-plan.json --yes   # disabled: see #14
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

## Develop

Working on the tool itself, rather than using it:

```sh
git clone https://github.com/oveddan/mft-api.git
cd mft-api
pnpm install
pnpm run check
```

`pnpm run build` compiles to `dist/`, and `node dist/cli.js` is then equivalent
to the installed `mft-config` command. `pnpm pack` produces the publishable
tarball and runs the full check first.

`MFT_UNSAFE_APPLY=1` lifts the `apply` block so the write path can be exercised
against real hardware while [#14](https://github.com/oveddan/mft-api/issues/14)
is open. It is for developing this tool, not for getting work done — the defects
it steps around are real, and it is deliberately absent from the agent skill.

On Linux you need the ALSA development package required by RtMidi if you are
building the native dependency from source rather than using its prebuilds.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file
for the full text.
