# Read-only UI architecture

The visual configurator is a small local web application. `mft-config ui`
starts an HTTP server on `127.0.0.1:4783` and serves dependency-free HTML, CSS,
and browser JavaScript from `ui/`. The browser never opens MIDI ports. The Node
server reuses the same exporter and protocol decoder as `mft-config export`.

## Hard read-only boundary

The server imports `RtMidiReadOnlyBackend`, not `RtMidiBackend`. The read-only
backend has only `discover` and `connect`; it cannot create the separate
`ConfigurationWriteConnection` required by the applier. Its connection's only
send method runs every frame through `assertReadOnlyRequest` immediately before
the native MIDI output call.

The local HTTP surface is intentionally tiny:

- `GET /api/devices` sends Universal Identity Request and returns matching
  Twister ports.
- `POST /api/export` accepts only `{ "deviceIndex": <non-negative integer> }`
  and runs the complete read-only export.

There are no plan, apply, write, reset, system, or bootloader routes. Unknown
`/api/*` paths return 404 without opening a MIDI connection. The transport guard
still blocks a mutating or unknown SysEx frame if one reaches it. Tests assert
both layers.

The UI listens on loopback by default. `MFT_CONFIG_UI_HOST` can override the
host, but exposing a hardware-adjacent local service to a network is not
recommended. Responses use a same-origin Content Security Policy and do not
load remote assets.

## Browser model

`ui/app.js` is split into small state, API, validation, and rendering functions.
It validates imported snapshots before rendering. Imports stay entirely in the
browser, so offline inspection does not touch MIDI. Downloads serialize the
exact in-memory snapshot rather than reconstructing configuration fields.

The grid always renders 16 encoders in physical left-to-right, top-to-bottom
order. Bank tabs are created from the snapshot, so both four- and eight-bank
exports use the same rendering path. Each knob persistently shows all three
stored 7-bit color indices: active, inactive, and detent. Active and inactive
use the selected Classic or MF64 RGB palette; the indicator-ring detent uses its
separate red/blue balance. CSS previews are a screen approximation; the numeric
index displayed in the knob detail is authoritative because hardware LED output
depends on brightness and diffusion.

## Local development

Install and run all checks:

```sh
npm ci
npm run check
npm run test:package
```

Start the UI through the packaged command path:

```sh
npm run build
node dist/cli.js ui
```

Or use the contributor shortcut, which builds first:

```sh
npm run ui
```

Set a different loopback port when needed:

```sh
MFT_CONFIG_UI_PORT=4784 npm run ui
```

Then open the printed URL. Exercise device discovery with hardware attached,
or use **Open JSON snapshot** to test every view offline. Server tests inject a
fake read-only backend and never require MIDI hardware.
