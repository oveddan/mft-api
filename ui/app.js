import { colorCss, colorLabel, detentCss, detentLabel } from "./colors.js";

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "device-select", "discover-button", "read-button", "import-button", "import-input", "download-button", "status",
  "empty-state", "viewer", "capture-source", "identity-fields", "warnings", "bank-tabs", "knob-grid", "encoder-detail",
  "global-fields", "side-buttons", "global-raw", "raw-json",
].map((id) => [id, byId(id)]));

const state = { devices: [], snapshot: null, bank: 1, encoder: 1, source: "" };

export function assertSnapshot(value) {
  if (!value || typeof value !== "object") throw new Error("Snapshot must be a JSON object.");
  if (value.schemaVersion !== "djtt.mft.config-export.v1") throw new Error("Unsupported snapshot schema. Expected djtt.mft.config-export.v1.");
  const bankCount = value.capabilities?.bankCount;
  if (bankCount !== 4 && bankCount !== 8) throw new Error("Snapshot bankCount must be 4 or 8.");
  if (!Array.isArray(value.banks) || value.banks.length !== bankCount) throw new Error(`Snapshot must contain exactly ${bankCount} banks.`);
  const bankNumbers = new Set();
  for (const bank of value.banks) {
    if (!Number.isInteger(bank.number) || bank.number < 1 || bank.number > bankCount || bankNumbers.has(bank.number)) throw new Error("Snapshot contains an invalid or duplicate bank number.");
    bankNumbers.add(bank.number);
    if (!Array.isArray(bank.encoders) || bank.encoders.length !== 16) throw new Error(`Bank ${bank.number ?? "?"} must contain 16 encoders.`);
    const encoderNumbers = new Set();
    for (const encoder of bank.encoders) {
      if (!Number.isInteger(encoder.number) || encoder.number < 1 || encoder.number > 16 || encoderNumbers.has(encoder.number)) throw new Error(`Bank ${bank.number} contains an invalid or duplicate encoder number.`);
      encoderNumbers.add(encoder.number);
      if (!encoder.rawTags || !encoder.colors || !encoder.detent || !encoder.switch || !encoder.encoder) throw new Error(`Bank ${bank.number}, encoder ${encoder.number} is incomplete.`);
    }
  }
  if (!value.device?.firmware?.date || !value.globals?.rawTags || !Array.isArray(value.globals.sideButtons) || !Array.isArray(value.warnings)) throw new Error("Snapshot is missing device, global, side-button, or warning fields.");
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) throw new Error("Snapshot is missing a valid capturedAt timestamp.");
  if (!value.device?.midiPorts || typeof value.device.midiPorts.input !== "string" || typeof value.device.midiPorts.output !== "string") throw new Error("Snapshot is missing device MIDI port names.");
  if (!Array.isArray(value.device.firmware.identityBytes)) throw new Error("Snapshot is missing device firmware identity bytes.");
  const globals = value.globals;
  if (
    typeof globals.colorMap?.name !== "string" ||
    typeof globals.superKnob?.start !== "number" ||
    typeof globals.superKnob?.end !== "number" ||
    typeof globals.brightness?.rgb !== "number" ||
    typeof globals.brightness?.indicator !== "number" ||
    typeof globals.animationChannels?.encoder !== "number" ||
    typeof globals.animationChannels?.switch !== "number" ||
    !globals.sleep ||
    typeof globals.sleep.timeoutIndex !== "number"
  ) {
    throw new Error("Snapshot is missing required global fields (colorMap, superKnob, brightness, animationChannels, or sleep).");
  }
  return value;
}

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function field(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = String(value ?? "—");
  return [dt, dd];
}

function renderFields(container, entries) {
  container.replaceChildren(...entries.flatMap(([label, value]) => field(label, value)));
}

function named(value) {
  return value ? `${value.name} (${value.code})` : "—";
}

function paletteName() {
  return state.snapshot.globals.colorMap.name === "mf64" ? "mf64" : "classic";
}

function renderIdentity() {
  const snapshot = state.snapshot;
  elements["capture-source"].textContent = `${state.source} · captured ${new Date(snapshot.capturedAt).toLocaleString()}`;
  renderFields(elements["identity-fields"], [
    ["Manufacturer", snapshot.device.manufacturer], ["Firmware", snapshot.device.firmware.date],
    ["Family / model", `${snapshot.device.familyId} / ${snapshot.device.modelId}`], ["Banks", snapshot.capabilities.bankCount],
    ["Unit ID", snapshot.device.unitId ? `${snapshot.device.unitId.hex} (${snapshot.device.unitId.source})` : "Unavailable"],
    ["MIDI input", snapshot.device.midiPorts.input], ["MIDI output", snapshot.device.midiPorts.output],
    ["Identity bytes", snapshot.device.firmware.identityBytes.join(" ")],
  ]);
  elements.warnings.replaceChildren();
  if (snapshot.warnings.length) {
    const box = document.createElement("div"); box.className = "warning";
    const title = document.createElement("strong"); title.textContent = `${snapshot.warnings.length} compatibility warning${snapshot.warnings.length === 1 ? "" : "s"}`;
    const list = document.createElement("ul");
    for (const warning of snapshot.warnings) { const item = document.createElement("li"); item.textContent = warning; list.append(item); }
    box.append(title, list); elements.warnings.append(box);
  }
}

function renderBanks() {
  elements["bank-tabs"].replaceChildren();
  for (const bank of state.snapshot.banks) {
    const button = document.createElement("button");
    button.textContent = `Bank ${bank.number}`; button.type = "button"; button.role = "tab";
    button.id = `bank-tab-${bank.number}`; button.setAttribute("aria-controls", "knob-grid");
    button.ariaSelected = String(bank.number === state.bank); button.dataset.active = String(bank.number === state.bank);
    button.tabIndex = bank.number === state.bank ? 0 : -1;
    button.addEventListener("click", () => selectBank(bank.number));
    button.addEventListener("keydown", (event) => {
      const numbers = state.snapshot.banks.map((candidate) => candidate.number);
      const current = numbers.indexOf(bank.number);
      let next;
      if (event.key === "ArrowRight") next = numbers[(current + 1) % numbers.length];
      if (event.key === "ArrowLeft") next = numbers[(current - 1 + numbers.length) % numbers.length];
      if (event.key === "Home") next = numbers[0];
      if (event.key === "End") next = numbers.at(-1);
      if (next !== undefined) { event.preventDefault(); selectBank(next, true); }
    });
    elements["bank-tabs"].append(button);
  }
  elements["knob-grid"].role = "tabpanel";
  elements["knob-grid"].setAttribute("aria-labelledby", `bank-tab-${state.bank}`);
}

function selectBank(number, focus = false) {
  state.bank = number; state.encoder = 1; renderBanks(); renderGrid();
  if (focus) byId(`bank-tab-${number}`).focus();
}

function currentEncoder() {
  return state.snapshot.banks.find((bank) => bank.number === state.bank)?.encoders.find((encoder) => encoder.number === state.encoder);
}

function renderGrid() {
  const bank = state.snapshot.banks.find((candidate) => candidate.number === state.bank);
  elements["knob-grid"].replaceChildren();
  for (const encoder of bank.encoders) {
    const button = document.createElement("button"); button.type = "button"; button.className = "knob";
    button.dataset.selected = String(encoder.number === state.encoder);
    const palette = paletteName();
    button.style.setProperty("--active", colorCss(encoder.colors.active, palette));
    button.style.setProperty("--inactive", colorCss(encoder.colors.inactive, palette));
    button.style.setProperty("--detent", detentCss(encoder.detent.color));
    button.setAttribute("aria-label", `Encoder ${encoder.number}. Active ${colorLabel(encoder.colors.active, palette)}, inactive ${colorLabel(encoder.colors.inactive, palette)}, detent ${detentLabel(encoder.detent.color)}`);
    const ring = document.createElement("span"); ring.className = "knob-ring"; ring.ariaHidden = "true";
    const center = document.createElement("span"); center.className = "knob-center"; center.ariaHidden = "true";
    const number = document.createElement("span"); number.className = "knob-number"; number.textContent = String(encoder.number);
    ring.append(center); button.append(ring, number);
    button.addEventListener("click", () => { state.encoder = encoder.number; renderGrid(); });
    elements["knob-grid"].append(button);
  }
  renderEncoderDetail(currentEncoder());
}

function colorRow(label, index, detent = false) {
  const row = document.createElement("div"); row.className = "color-row";
  const swatch = document.createElement("i"); swatch.style.background = detent ? detentCss(index) : colorCss(index, paletteName());
  const text = document.createElement("span"); text.textContent = `${label}: ${detent ? detentLabel(index) : colorLabel(index, paletteName())}`;
  row.append(swatch, text); return row;
}

function renderEncoderDetail(encoder) {
  const detail = elements["encoder-detail"];
  detail.replaceChildren();
  const title = document.createElement("h3"); title.textContent = `Bank ${state.bank} · Encoder ${encoder.number}`;
  const colors = document.createElement("div"); colors.className = "color-list";
  colors.append(colorRow("Active", encoder.colors.active), colorRow("Inactive", encoder.colors.inactive), colorRow("Detent", encoder.detent.color, true));
  const fields = document.createElement("dl"); fields.className = "detail-fields";
  renderFields(fields, [
    ["Rotary MIDI", `Ch ${encoder.encoder.midiChannel} · #${encoder.encoder.midiNumber}`],
    ["Shifted channel", encoder.encoder.shiftedMidiChannel], ["Rotary type", named(encoder.encoder.type)],
    ["Movement", named(encoder.movement)], ["Push MIDI", `Ch ${encoder.switch.midiChannel} · #${encoder.switch.midiNumber}`],
    ["Push action", named(encoder.switch.action)], ["Indicator", named(encoder.indicator)],
    ["Detent enabled", encoder.detent.enabled ? "Yes" : "No"], ["Super knob", encoder.superKnobEnabled ? "Enabled" : "Disabled"],
  ]);
  const raw = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Raw encoder tags";
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(encoder.rawTags, null, 2); raw.append(summary, pre);
  detail.append(title, colors, fields, raw);
}

function renderGlobals() {
  const globals = state.snapshot.globals;
  renderFields(elements["global-fields"], [
    ["MIDI channel", globals.midiChannel], ["Side buttons banked", globals.sideButtonsBanked ? "Yes" : "No"],
    ["Super knob range", `${globals.superKnob.start}–${globals.superKnob.end}`], ["RGB brightness", globals.brightness.rgb],
    ["Indicator brightness", globals.brightness.indicator], ["Color map", named(globals.colorMap)],
    ["Encoder animation channel", globals.animationChannels.encoder], ["Switch animation channel", globals.animationChannels.switch],
    ["Sleep timeout", globals.sleep.timeoutMinutes === null ? `Unknown (${globals.sleep.timeoutIndex})` : `${globals.sleep.timeoutMinutes} min (index ${globals.sleep.timeoutIndex})`],
    ["Sleep animation", named(globals.sleep.animation)], ["Bank animations", globals.bankAnimationsEnabled ? "Enabled" : "Disabled"],
  ]);
  elements["side-buttons"].replaceChildren(...globals.sideButtons.map((button) => {
    const item = document.createElement("div"); item.className = "side-button";
    const number = document.createElement("strong"); number.textContent = String(button.number);
    const action = document.createElement("span"); action.textContent = named(button.action); item.append(number, action); return item;
  }));
  elements["global-raw"].textContent = JSON.stringify(globals.rawTags, null, 2);
}

function renderAll(snapshot) {
  renderIdentity(); renderBanks(); renderGrid(); renderGlobals();
  elements["raw-json"].textContent = JSON.stringify(snapshot, null, 2);
}

// Renders defensively: a snapshot is only committed to `state` and the viewer only
// unhidden once every render function has run without throwing. If rendering the new
// snapshot fails partway through (leaving the DOM with a mix of new and old content),
// the previous good snapshot (or the empty state, if there was none) is redrawn from
// scratch so the user never sees a spliced/corrupted view.
export function renderSnapshot(snapshot, source) {
  const validated = assertSnapshot(snapshot);
  const previous = { snapshot: state.snapshot, bank: state.bank, encoder: state.encoder, source: state.source };
  state.snapshot = validated; state.bank = validated.banks[0].number; state.encoder = 1; state.source = source;
  try {
    renderAll(snapshot);
  } catch (error) {
    state.snapshot = previous.snapshot; state.bank = previous.bank; state.encoder = previous.encoder; state.source = previous.source;
    if (previous.snapshot) {
      try { renderAll(previous.snapshot); } catch { /* best-effort restore; fall through to error below */ }
    } else {
      elements["empty-state"].hidden = false; elements.viewer.hidden = true; elements["download-button"].disabled = true;
    }
    throw new Error(`Snapshot could not be rendered: ${error.message}`);
  }
  elements["empty-state"].hidden = true; elements.viewer.hidden = false; elements["download-button"].disabled = false;
}

async function discover() {
  setStatus("Discovering MIDI devices…"); elements["discover-button"].disabled = true; elements["read-button"].disabled = true;
  try {
    const { devices } = await api("/api/devices"); state.devices = devices;
    elements["device-select"].replaceChildren();
    if (!devices.length) {
      const option = new Option("No MIDI Fighter Twister found", ""); elements["device-select"].append(option);
      setStatus("No Twister responded. Check USB power, cable, MIDI permissions, and that no other app owns the port.", "error");
    } else {
      for (const device of devices) elements["device-select"].append(new Option(`${device.outputPort} · firmware ${device.firmwareDate}`, String(device.index)));
      elements["read-button"].disabled = false; setStatus(`Found ${devices.length} Twister${devices.length === 1 ? "" : "s"}.`, "success");
    }
  } catch (error) { setStatus(error.message, "error"); }
  finally { elements["discover-button"].disabled = false; }
}

async function readDevice() {
  const deviceIndex = Number(elements["device-select"].value);
  if (!Number.isInteger(deviceIndex)) return;
  const selected = state.devices[deviceIndex];
  setStatus("Reading globals and every encoder. This can take a moment…"); elements["read-button"].disabled = true;
  try {
    // inputPort/outputPort let the server confirm the device at this index hasn't
    // changed since discovery (e.g. a controller was unplugged/replugged); if it
    // has, the server rejects the request instead of silently reading the wrong one.
    const body = { deviceIndex, ...(selected ? { inputPort: selected.inputPort, outputPort: selected.outputPort } : {}) };
    const { snapshot } = await api("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    renderSnapshot(snapshot, "Live controller"); setStatus(`Read all ${snapshot.capabilities.bankCount * 16} encoder records successfully.`, "success");
  } catch (error) { setStatus(error.message, "error"); }
  finally { elements["read-button"].disabled = state.devices.length === 0; }
}

async function importSnapshot(file) {
  try {
    const snapshot = JSON.parse(await file.text()); renderSnapshot(snapshot, `Offline snapshot · ${file.name}`);
    setStatus(`Opened ${file.name} without accessing MIDI hardware.`, "success");
  } catch (error) { setStatus(`Could not open snapshot: ${error.message}`, "error"); }
  finally { elements["import-input"].value = ""; }
}

function downloadSnapshot() {
  const blob = new Blob([`${JSON.stringify(state.snapshot, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  const id = state.snapshot.device.unitId?.hex ?? "twister"; link.download = `mft-${id}-${state.snapshot.capturedAt.slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); setStatus(`Downloaded ${link.download}.`, "success");
}

elements["discover-button"].addEventListener("click", discover);
elements["read-button"].addEventListener("click", readDevice);
elements["device-select"].addEventListener("change", () => { elements["read-button"].disabled = elements["device-select"].value === ""; });
elements["import-button"].addEventListener("click", () => elements["import-input"].click());
elements["import-input"].addEventListener("change", () => { const file = elements["import-input"].files[0]; if (file) importSnapshot(file); });
elements["download-button"].addEventListener("click", downloadSnapshot);
