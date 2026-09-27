import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function prepareDevSystemMonitorEnv(
  baseEnv,
  repoRoot,
  { build = spawnSync, binaryExists = existsSync, platform = process.platform } = {},
) {
  const env = { ...baseEnv };
  if (env.BIGBUD_SYSTEM_MONITOR_ENABLED === "0" || env.BIGBUD_SYSTEM_MONITOR_BINARY) return env;

  const result = build("cargo", ["build", "--locked", "--package", "bigbud-desktop-supervisor"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      "[system-monitor] Could not build the desktop supervisor; monitoring is unavailable.",
    );
    return env;
  }

  const targetRoot = resolve(repoRoot, env.CARGO_TARGET_DIR || "target");
  const binary = join(
    targetRoot,
    ...(env.CARGO_BUILD_TARGET ? [env.CARGO_BUILD_TARGET] : []),
    "debug",
    platform === "win32" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor",
  );
  if (!binaryExists(binary)) {
    console.error(
      `[system-monitor] Built supervisor not found at ${binary}; monitoring is unavailable.`,
    );
    return env;
  }
  env.BIGBUD_SYSTEM_MONITOR_BINARY = binary;
  return env;
}
