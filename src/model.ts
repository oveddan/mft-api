import type { Identity } from "./protocol.js";

export interface NamedCode {
  code: number;
  name: string;
}

export interface DeviceDescriptor {
  inputPort: { index: number; name: string };
  outputPort: { index: number; name: string };
  identity: Identity;
}

export interface EncoderExport {
  number: number;
  detent: { enabled: boolean; color: number };
  movement: NamedCode;
  switch: { action: NamedCode; midiChannel: number; midiNumber: number };
  encoder: {
    midiChannel: number;
    shiftedMidiChannel: number;
    midiNumber: number;
    type: NamedCode;
  };
  colors: { active: number; inactive: number };
  indicator: NamedCode;
  superKnobEnabled: boolean;
  rawTags: Record<string, number>;
}

export interface ConfigExport {
  schemaVersion: "djtt.mft.config-export.v1";
  capturedAt: string;
  device: {
    manufacturer: "DJ TechTools";
    manufacturerId: [number, number, number];
    familyId: number;
    modelId: number;
    firmware: { date: string; identityBytes: [number, number, number, number] };
    unitId: { source: "sysex-0x05" | "usb-serial"; hex: string } | null;
    midiPorts: { input: string; output: string };
  };
  capabilities: { bankCount: 4 | 8; encodersPerBank: 16 };
  globals: {
    midiChannel: number;
    sideButtonsBanked: boolean;
    sideButtons: Array<{ number: number; action: NamedCode }>;
    superKnob: { start: number; end: number };
    brightness: { rgb: number; indicator: number };
    colorMap: NamedCode;
    animationChannels: { encoder: number; switch: number };
    sleep: { timeoutIndex: number; timeoutMinutes: number | null; animation: NamedCode };
    bankAnimationsEnabled: boolean;
    rawTags: Record<string, number>;
  };
  banks: Array<{ number: number; encoders: EncoderExport[] }>;
  warnings: string[];
}

const SIDE_ACTIONS = [
  "ccHold",
  "ccToggle",
  "noteHold",
  "noteToggle",
  "shiftPage1Hold",
  "shiftPage2Hold",
  "shiftPage1Toggle",
  "shiftPage2Toggle",
  "bankUp",
  "bankDown",
  "bankSelect",
  "bank1",
  "bank2",
  "bank3",
  "bank4",
  "bank5",
  "bank6",
  "bank7",
  "bank8",
  "cycleBank",
] as const;

const SWITCH_ACTIONS = [
  "ccHold",
  "ccToggle",
  "noteHold",
  "noteToggle",
  "resetToZero",
  "resetToMaximum",
  "fineAdjust",
  "shiftHold",
  "shiftToggle",
] as const;

const MOVEMENTS = ["direct", "responsive", "velocitySensitive"] as const;
const MIDI_TYPES = ["note", "cc", "relativeEncoder", "switchVelocityControl", "mouseDrag", "mouseScroll"] as const;
const INDICATORS = ["dot", "bar", "blendedBar", "spreadBar"] as const;
const SLEEP_ANIMATIONS = ["lightsOff", "rainbowWave"] as const;
const SLEEP_MINUTES = [0, 1, 3, 5, 10, 20, 30, 60] as const;

function named(code: number, names: readonly string[]): NamedCode {
  return { code, name: names[code] ?? `unknown-${code}` };
}

function required(values: Map<number, number>, tag: number, context: string): number {
  const value = values.get(tag);
  if (value === undefined) throw new Error(`${context} is missing tag ${tag}`);
  return value;
}

export function rawTags(values: Map<number, number>): Record<string, number> {
  return Object.fromEntries([...values.entries()].map(([tag, value]) => [String(tag), value]));
}

export function normalizeGlobals(values: Map<number, number>, warnings: string[]): ConfigExport["globals"] {
  const sleepIndex = values.get(36) ?? 0;
  const sleepMinutes = SLEEP_MINUTES[sleepIndex] ?? null;
  if (sleepMinutes === null) warnings.push(`Unknown sleep timeout index ${sleepIndex}`);

  for (const tag of [33, 34, 35, 36, 37, 38]) {
    if (!values.has(tag)) warnings.push(`Firmware did not return 2026 global tag ${tag}`);
  }

  const sideButtons = Array.from({ length: 6 }, (_, index) => {
    const code = required(values, index + 2, `Side button ${index + 1}`);
    return { number: index + 1, action: named(code, SIDE_ACTIONS) };
  });

  const colorMapCode = values.get(33) ?? 0;
  return {
    midiChannel: required(values, 0, "Globals"),
    sideButtonsBanked: required(values, 1, "Globals") !== 0,
    sideButtons,
    superKnob: {
      start: required(values, 8, "Globals"),
      end: required(values, 9, "Globals"),
    },
    brightness: {
      rgb: required(values, 31, "Globals"),
      indicator: required(values, 32, "Globals"),
    },
    colorMap: { code: colorMapCode, name: colorMapCode === 1 ? "mf64" : "classic" },
    animationChannels: { encoder: values.get(34) ?? 6, switch: values.get(35) ?? 3 },
    sleep: {
      timeoutIndex: sleepIndex,
      timeoutMinutes: sleepMinutes,
      animation: named(values.get(37) ?? 0, SLEEP_ANIMATIONS),
    },
    bankAnimationsEnabled: (values.get(38) ?? 0) !== 0,
    rawTags: rawTags(values),
  };
}

export function normalizeEncoder(
  values: Map<number, number>,
  number: number,
  firmwareDate: string,
  warnings: string[],
): EncoderExport {
  const context = `Encoder ${number}`;
  const rawShiftedChannel = required(values, 24, context);
  const shiftedMidiChannel = firmwareDate >= "2026-07-02" ? rawShiftedChannel : rawShiftedChannel + 1;
  if (values.get(15) !== 0) warnings.push(`${context} returned unexpected deprecated tag 15 value ${values.get(15)}`);

  return {
    number,
    detent: {
      enabled: required(values, 10, context) !== 0,
      color: required(values, 21, context),
    },
    movement: named(required(values, 11, context), MOVEMENTS),
    switch: {
      action: named(required(values, 12, context), SWITCH_ACTIONS),
      midiChannel: required(values, 13, context),
      midiNumber: required(values, 14, context),
    },
    encoder: {
      midiChannel: required(values, 16, context),
      shiftedMidiChannel,
      midiNumber: required(values, 17, context),
      type: named(required(values, 18, context), MIDI_TYPES),
    },
    colors: {
      active: required(values, 19, context),
      inactive: required(values, 20, context),
    },
    indicator: named(required(values, 22, context), INDICATORS),
    superKnobEnabled: required(values, 23, context) !== 0,
    rawTags: rawTags(values),
  };
}
