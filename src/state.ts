import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface StateDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Keep backups and the single-use-plan journal stable regardless of the
 * directory from which a globally installed command is invoked.
 */
export function stateDirectory(options: StateDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const override = env.MFT_CONFIG_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("MFT_CONFIG_STATE_DIR must be an absolute path");
    return override;
  }
  if (env.XDG_STATE_HOME) {
    if (!isAbsolute(env.XDG_STATE_HOME)) throw new Error("XDG_STATE_HOME must be an absolute path");
    return join(env.XDG_STATE_HOME, "mft-config");
  }
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "mft-config");
  return join(home, ".mft-config");
}
