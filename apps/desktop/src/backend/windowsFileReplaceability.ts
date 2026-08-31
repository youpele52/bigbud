import * as ChildProcess from "node:child_process";

import {
  WINDOWS_FILE_REPLACEABILITY_SCRIPT,
  WINDOWS_REPLACEABILITY_PATHS_ENV,
} from "./windowsFileReplaceability.script";
import {
  resolveTrustedWindowsPowerShell,
  type TrustedWindowsPowerShell,
} from "./windowsPowerShell";

export interface WindowsReplaceabilityTarget {
  readonly label: string;
  readonly path: string;
}

interface WindowsFileReplaceabilityDeps {
  readonly platform: NodeJS.Platform;
  readonly resolvePowerShell: () => TrustedWindowsPowerShell;
  readonly spawnSync: typeof ChildProcess.spawnSync;
}

const defaultDeps: WindowsFileReplaceabilityDeps = {
  platform: process.platform,
  resolvePowerShell: resolveTrustedWindowsPowerShell,
  spawnSync: ChildProcess.spawnSync,
};

// Windows PowerShell 5.1 can spend more than 15 seconds compiling the native helper on a cold host.
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export function assertWindowsFilesReplaceable(input: {
  readonly targets: ReadonlyArray<WindowsReplaceabilityTarget>;
  readonly commandTimeoutMs?: number;
  readonly deps?: WindowsFileReplaceabilityDeps;
}): void {
  const deps = input.deps ?? defaultDeps;
  if (deps.platform !== "win32" || input.targets.length === 0) return;
  const timeout = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (timeout < 1)
    throw new Error("Windows file replaceability probe received an invalid timeout.");
  const powerShell = deps.resolvePowerShell();
  const result = deps.spawnSync(
    powerShell.executablePath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_FILE_REPLACEABILITY_SCRIPT,
    ],
    {
      cwd: powerShell.cwd,
      encoding: "utf8",
      env: {
        ...powerShell.env,
        [WINDOWS_REPLACEABILITY_PATHS_ENV]: JSON.stringify(input.targets.map(({ path }) => path)),
      },
      maxBuffer: 64 * 1024,
      timeout,
      windowsHide: true,
    },
  );
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new Error(
      timedOut
        ? "Windows file replaceability probe exceeded its command timeout."
        : "Windows file replaceability probe could not start trusted PowerShell.",
    );
  }
  if (typeof result.stdout !== "string" || result.stderr?.trim()) {
    throw new Error("Windows file replaceability probe returned an unexpected command result.");
  }
  const output = parseProbeOutput(result.stdout);
  if (result.status === 0 && output.status === "ok" && output.checked === input.targets.length)
    return;
  const target = output.status === "error" ? input.targets[output.index ?? -1] : undefined;
  const label = target?.label ?? "an installed runtime file";
  const detail =
    output.status === "error" ? ` (${output.code}, win32=${output.win32Error ?? "unknown"})` : "";
  throw new Error(
    `Windows could not prove ${label} is replaceable${detail}. Restart bigbud and try again; if the lock persists, run as administrator or install the update manually. Third-party and antivirus locks are detected but are not terminated automatically.`,
  );
}

type ProbeOutput =
  | { readonly status: "ok"; readonly checked: number }
  | {
      readonly status: "error";
      readonly code: string;
      readonly index?: number;
      readonly win32Error?: number;
    };

function parseProbeOutput(stdout: string): ProbeOutput {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Windows file replaceability probe returned malformed output.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Windows file replaceability probe returned malformed output.");
  }
  const output = value as Record<string, unknown>;
  if (
    output.status === "ok" &&
    Number.isSafeInteger(output.checked) &&
    (output.checked as number) >= 0 &&
    Object.keys(output).length === 2
  ) {
    return output as ProbeOutput;
  }
  if (
    output.status === "error" &&
    typeof output.code === "string" &&
    (output.index === undefined || Number.isSafeInteger(output.index)) &&
    (output.win32Error === undefined || Number.isSafeInteger(output.win32Error)) &&
    Object.keys(output).every((key) => ["status", "code", "index", "win32Error"].includes(key))
  ) {
    return output as ProbeOutput;
  }
  throw new Error("Windows file replaceability probe returned malformed output.");
}
