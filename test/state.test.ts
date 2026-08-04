import assert from "node:assert/strict";
import test from "node:test";

import { stateDirectory } from "../src/state.js";

test("uses a stable per-user directory for journals and backups", () => {
  assert.equal(stateDirectory({ env: {}, home: "/home/example", platform: "linux" }), "/home/example/.mft-config");
  assert.equal(stateDirectory({ env: { XDG_STATE_HOME: "/state" }, home: "/home/example", platform: "linux" }), "/state/mft-config");
  assert.equal(stateDirectory({ env: { LOCALAPPDATA: "C:\\State" }, home: "C:\\Users\\example", platform: "win32" }), "C:\\State/mft-config");
  assert.equal(stateDirectory({ env: { MFT_CONFIG_STATE_DIR: "/custom" }, home: "/home/example" }), "/custom");
  assert.throws(() => stateDirectory({ env: { MFT_CONFIG_STATE_DIR: "relative" }, home: "/home/example" }), /must be an absolute path/);
});
