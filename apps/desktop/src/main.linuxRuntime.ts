import * as FS from "node:fs";
import * as Path from "node:path";

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const LINUX_BACKEND_MAX_OLD_SPACE_MB = 1024;
const LINUX_CONSERVATIVE_BACKEND_MAX_OLD_SPACE_MB = 768;

export type LinuxOzonePlatform = "x11" | "wayland";

export interface LinuxDesktopRuntimeConfig {
  readonly backendMaxOldSpaceMb: number | null;
  readonly conservativeMode: boolean;
  readonly disableHardwareAcceleration: boolean;
  readonly gpuFallbackMarkerArmed: boolean;
  readonly ozonePlatform: LinuxOzonePlatform | null;
  readonly spellcheckEnabled: boolean;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, ...names: ReadonlyArray<string>): boolean | null {
  for (const name of names) {
    const value = env[name]?.trim().toLowerCase();
    if (!value) continue;
    if (TRUE_ENV_VALUES.has(value)) return true;
    if (FALSE_ENV_VALUES.has(value)) return false;
  }
  return null;
}

function readIntegerEnv(env: NodeJS.ProcessEnv, ...names: ReadonlyArray<string>): number | null {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;

    const numericValue = Number.parseInt(rawValue, 10);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }
  return null;
}

function readOzonePlatformEnv(
  env: NodeJS.ProcessEnv,
  ...names: ReadonlyArray<string>
): LinuxOzonePlatform | null {
  for (const name of names) {
    const value = env[name]?.trim().toLowerCase();
    if (value === "x11" || value === "wayland") {
      return value;
    }
  }
  return null;
}

export function resolveLinuxGpuFallbackMarkerPath(stateDir: string): string {
  return Path.join(stateDir, "linux-gpu-fallback.json");
}

export function readLinuxGpuFallbackMarker(markerPath: string): boolean {
  try {
    return FS.existsSync(markerPath);
  } catch {
    return false;
  }
}

export function armLinuxGpuFallbackMarker(markerPath: string): void {
  try {
    FS.mkdirSync(Path.dirname(markerPath), { recursive: true });
    FS.writeFileSync(
      markerPath,
      JSON.stringify({ armedAt: new Date().toISOString(), version: 1 }, null, 2),
      "utf8",
    );
  } catch {
    // Never let a fallback marker write block app runtime.
  }
}

export function clearLinuxGpuFallbackMarker(markerPath: string): void {
  try {
    FS.rmSync(markerPath, { force: true });
  } catch {
    // Marker cleanup is best-effort only.
  }
}

export function shouldArmLinuxGpuFallback(reason: string | undefined): boolean {
  const normalizedReason = reason?.trim().toLowerCase();
  return (
    normalizedReason === "crashed" ||
    normalizedReason === "launch-failed" ||
    normalizedReason === "oom" ||
    normalizedReason === "integrity-failure"
  );
}

export function resolveLinuxDesktopRuntimeConfig(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly gpuFallbackMarkerArmed?: boolean;
  readonly platform?: NodeJS.Platform;
}): LinuxDesktopRuntimeConfig {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const gpuFallbackMarkerArmed = options.gpuFallbackMarkerArmed === true;
  const conservativeMode =
    readBooleanEnv(env, "BIGBUD_LINUX_CONSERVATIVE_MODE", "T3CODE_LINUX_CONSERVATIVE_MODE") ===
    true;
  const explicitDisableHardwareAcceleration = readBooleanEnv(
    env,
    "BIGBUD_LINUX_DISABLE_HARDWARE_ACCELERATION",
    "T3CODE_LINUX_DISABLE_HARDWARE_ACCELERATION",
  );
  const disableHardwareAcceleration =
    platform === "linux" &&
    (explicitDisableHardwareAcceleration ?? (conservativeMode || gpuFallbackMarkerArmed));
  const ozonePlatform =
    platform === "linux"
      ? readOzonePlatformEnv(env, "BIGBUD_LINUX_OZONE_PLATFORM", "T3CODE_LINUX_OZONE_PLATFORM")
      : null;
  const backendMaxOldSpaceMb =
    readIntegerEnv(
      env,
      "BIGBUD_DESKTOP_BACKEND_MAX_OLD_SPACE_MB",
      "T3CODE_DESKTOP_BACKEND_MAX_OLD_SPACE_MB",
    ) ??
    (platform === "linux"
      ? conservativeMode
        ? LINUX_CONSERVATIVE_BACKEND_MAX_OLD_SPACE_MB
        : LINUX_BACKEND_MAX_OLD_SPACE_MB
      : null);

  return {
    backendMaxOldSpaceMb,
    conservativeMode,
    disableHardwareAcceleration,
    gpuFallbackMarkerArmed,
    ozonePlatform,
    spellcheckEnabled: !(platform === "linux" && conservativeMode),
  };
}
