import * as FS from "node:fs";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import type { CommandLineLauncherResult } from "./commandLineLauncher.ts";

export const BIGBUD_WINDOWS_LAUNCHER_MARKER = "rem bigbud command-line launcher (generated)";
export const WINDOWS_COMMAND_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"] as const;

export function buildWindowsCommandLineLauncher(input: {
  readonly runtime: string;
  readonly script: string;
}): string | null {
  if ([input.runtime, input.script].some((value) => value.includes("\0") || /[\r\n]/.test(value)))
    return null;
  const descriptor = `bigbud-cli-launcher-v1\n${input.runtime}\n${input.script}\n`;
  return Buffer.byteLength(descriptor) <= 32768 ? descriptor : null;
}
function regular(path: string): boolean {
  return FS.lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}
function legacy(path: string): string | null {
  if (!regular(path) || FS.statSync(path).size > 65536) return null;
  const text = FS.readFileSync(path, "utf8");
  return text.split(/\r?\n/, 3).includes(BIGBUD_WINDOWS_LAUNCHER_MARKER) ? text : null;
}

/** The native installer owns OS locking, immutable generations and interrupted-write recovery. */
export function installWindowsCommandLineLauncher(input: {
  readonly homeDir: string;
  readonly pathValue: string;
  readonly commandName: string;
  readonly runtime: string;
  readonly script: string;
  readonly shim: string;
}): CommandLineLauncherResult {
  if (
    !buildWindowsCommandLineLauncher(input) ||
    !Path.isAbsolute(input.shim) ||
    !regular(input.shim)
  ) {
    return {
      status: "unsupported",
      reason: "The bundled native CLI launcher is missing or invalid.",
    };
  }
  const binDir = Path.join(input.homeDir, ".local", "bin");
  const destination = Path.join(binDir, `${input.commandName}.exe`);
  const oldCmd = Path.join(binDir, `${input.commandName}.cmd`);
  const oldBytes = legacy(oldCmd);
  const comparable = (value: string) => Path.resolve(value).toLowerCase();
  for (const directory of input.pathValue.split(";").filter(Boolean)) {
    for (const extension of WINDOWS_COMMAND_EXTENSIONS) {
      const candidate = Path.join(directory, `${input.commandName}${extension}`);
      if (!FS.lstatSync(candidate, { throwIfNoEntry: false })) continue;
      // The native transaction verifies ownership of this exact destination before publication.
      if (comparable(candidate) === comparable(destination)) continue;
      if (comparable(candidate) === comparable(oldCmd) && oldBytes !== null) continue;
      return { status: "existing-command", existingPath: candidate };
    }
  }
  if (FS.lstatSync(oldCmd, { throwIfNoEntry: false }) && oldBytes === null) {
    return { status: "existing-command", existingPath: oldCmd };
  }
  const existed = FS.lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
  const result = spawnSync(
    input.shim,
    ["--bigbud-cli-install-v1", destination, input.runtime, input.script],
    {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16384,
    },
  );
  if (result.error || result.status !== 0 || result.stdout.trim() !== "installed") {
    return {
      status: "unsupported",
      reason: result.stderr?.includes("BIGBUD_CLI_RECOVERY_LIMIT")
        ? "Interrupted CLI installation files need inspection before another installation. Your existing command has been preserved."
        : "Native CLI installation could not finish. Close running CLI commands and retry; unrelated commands are left untouched.",
    };
  }
  if (oldBytes !== null && legacy(oldCmd) === oldBytes) FS.unlinkSync(oldCmd);
  return {
    status: existed ? "updated" : "installed",
    launcherPath: destination,
    pathHint: input.pathValue
      .split(";")
      .filter(Boolean)
      .some((part) => comparable(part) === comparable(binDir))
      ? null
      : `Add ${binDir} to your user Path environment variable, then open a new terminal.`,
  };
}
