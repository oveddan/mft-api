import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "mft-config-package-"));
let tarballPath;
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this check through npm run test:package");

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? temporaryDirectory,
    encoding: "utf8",
    env: process.env,
  });
  if (options.status !== undefined) {
    assert.equal(result.status, options.status, `${binary} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  if (options.stdout) assert.match(result.stdout, options.stdout);
  if (options.stderr) assert.match(result.stderr, options.stderr);
  return result;
}

try {
  const packOutput = execFileSync(process.execPath, [npmCli, "pack", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.ok(packOutput.trim(), "npm pack did not return its JSON manifest");
  const [packed] = JSON.parse(packOutput);
  assert.ok(packed?.filename, "npm pack did not report a tarball filename");
  tarballPath = join(repositoryRoot, packed.filename);

  const paths = packed.files.map((file) => file.path).sort();
  const required = [
    "README.md",
    "dist/cli.js",
    "dist/applier.js",
    "dist/ui-server.js",
    "docs/ui-architecture.md",
    "docs/write-safety.md",
    "package.json",
    "schema/config-export.schema.json",
    "schema/patch-plan.schema.json",
    "ui/index.html",
    "ui/app.js",
    "ui/colors.js",
    "ui/styles.css",
  ];
  for (const path of required) assert.ok(paths.includes(path), `packed artifact is missing ${path}`);
  for (const path of paths) {
    assert.match(path, /^(README\.md|package\.json|(?:LICENSE|LICENCE|COPYING)(?:\..+)?|dist\/.+\.js|docs\/(?:write-safety|ui-architecture)\.md|schema\/[^/]+\.json|ui\/(?:index\.html|app\.js|colors\.js|styles\.css))$/);
  }
  assert.ok(!paths.some((path) => /(^|\/)(src|test|scripts|node_modules|\.mft-state)(\/|$)/.test(path)));

  const installRoot = join(temporaryDirectory, "install");
  run(process.execPath, [npmCli, "install", "--prefix", installRoot, "--no-audit", "--no-fund", tarballPath], { status: 0 });
  const command = join(installRoot, "node_modules", ".bin", "mft-config");
  const legacyCommand = join(installRoot, "node_modules", ".bin", "mft-export");

  run(command, ["--help"], { status: 0, stdout: /^Usage:\n  mft-config list/m });
  run(legacyCommand, ["--help"], { status: 0, stdout: /^Usage:\n  mft-config list/m, stderr: /mft-export is deprecated/ });
  run(command, ["list", "--timeout", "99"], { status: 1, stderr: /--timeout must be an integer/ });
  run(command, ["export", "--device", "-1"], { status: 1, stderr: /--device must be a non-negative integer/ });
  run(command, ["plan"], { status: 1, stderr: /plan requires --snapshot/ });
  run(command, ["apply"], { status: 1, stderr: /apply requires --plan/ });

  const snapshotPath = join(temporaryDirectory, "snapshot.json");
  const planPath = join(temporaryDirectory, "plan.json");
  const snapshot = {
    schemaVersion: "djtt.mft.config-export.v1",
    capturedAt: "2026-08-03T00:00:00.000Z",
    device: {
      manufacturer: "DJ TechTools",
      manufacturerId: [0, 1, 121],
      familyId: 5,
      modelId: 1,
      firmware: { date: "2026-07-02", identityBytes: [32, 38, 7, 2] },
      unitId: { source: "sysex-0x05", hex: "0102030405060708" },
      midiPorts: { input: "input-a", output: "output-a" },
    },
    capabilities: { bankCount: 4, encodersPerBank: 16 },
    globals: {
      midiChannel: 4,
      sideButtonsBanked: true,
      sideButtons: Array.from({ length: 6 }, (_, index) => ({ number: index + 1, action: { code: 0, name: "ccHold" } })),
      superKnob: { start: 63, end: 127 },
      brightness: { rgb: 127, indicator: 127 },
      colorMap: { code: 1, name: "mf64" },
      animationChannels: { encoder: 6, switch: 3 },
      sleep: { timeoutIndex: 7, timeoutMinutes: 60, animation: { code: 1, name: "rainbowWave" } },
      bankAnimationsEnabled: true,
      rawTags: { "0": 4, "1": 1, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 63, "9": 127, "31": 127, "32": 127, "33": 1, "34": 6, "35": 3, "36": 7, "37": 1, "38": 1 },
    },
    banks: [{
      number: 1,
      encoders: [{
        number: 1,
        detent: { enabled: false, color: 63 },
        movement: { code: 0, name: "direct" },
        switch: { action: { code: 0, name: "ccHold" }, midiChannel: 2, midiNumber: 0 },
        encoder: { midiChannel: 1, shiftedMidiChannel: 5, midiNumber: 0, type: { code: 1, name: "cc" } },
        colors: { active: 25, inactive: 5 },
        indicator: { code: 2, name: "blendedBar" },
        superKnobEnabled: false,
        rawTags: { "10": 0, "11": 0, "12": 0, "13": 2, "14": 0, "15": 0, "16": 1, "17": 0, "18": 1, "19": 25, "20": 5, "21": 63, "22": 2, "23": 0, "24": 5 },
      }],
    }],
    warnings: [],
  };
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  run(command, ["plan", "--snapshot", snapshotPath, "--set", "bank.1.encoder.1.colors.active=red", "--out", planPath], { status: 0 });
  assert.equal(JSON.parse(readFileSync(planPath, "utf8")).changes[0].path, "bank.1.encoder.1.colors.active");
  run(command, ["apply", "--plan", planPath], { status: 1, stderr: /explicit confirmation with --yes/ });

  process.stdout.write(`Packed and clean-installed ${packed.filename}; mft-config and mft-export smoke tests passed.\n`);
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
