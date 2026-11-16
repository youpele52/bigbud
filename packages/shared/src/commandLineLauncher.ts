import * as FS from "node:fs";
import * as Path from "node:path";

import {
  BIGBUD_WINDOWS_LAUNCHER_MARKER,
  installWindowsCommandLineLauncher,
  WINDOWS_COMMAND_EXTENSIONS,
} from "./commandLineLauncher.windows.ts";

/** Marker identifying a launcher bigbud wrote; anything else at the path is left untouched. */
export const BIGBUD_LAUNCHER_MARKER = "# bigbud command-line launcher (generated)";
export const BIGBUD_LAUNCHER_BOOTSTRAP_MARKER =
  "// bigbud command-line launcher bootstrap (generated)";

export type CommandLineLauncherResult =
  | {
      readonly status: "installed" | "updated";
      readonly launcherPath: string;
      /** Shell startup files are never edited; tell the person how to add the directory. */
      readonly pathHint: string | null;
    }
  | { readonly status: "existing-command"; readonly existingPath: string }
  | { readonly status: "unsupported"; readonly reason: string };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * How the launcher reaches the bundled server CLI. `direct`: a stable runtime and entry on disk
 * (macOS app bundle, Linux deb). `appimage`: the entry lives inside the AppImage's per-run mount,
 * so the launcher execs the stable `.AppImage` file with a generated bootstrap that imports the
 * entry relative to `$APPDIR`, which the AppImage runtime sets for each run.
 */
export type CommandLineLauncherTarget =
  | {
      readonly kind: "direct";
      readonly nodeExecutable: string;
      readonly serverEntry: string;
      readonly windowsShim?: string;
    }
  | {
      readonly kind: "appimage";
      readonly appImagePath: string;
      /** Entry path relative to `$APPDIR`, e.g. `resources/server/dist/bin.mjs`. */
      readonly serverEntryInAppDir: string;
    };

/**
 * Work out how a launcher reaches the running app's bundled CLI. Inside an AppImage the entry
 * lives under the per-run `$APPDIR` mount, so the launcher must go through the stable
 * `$APPIMAGE` file; everywhere else the runtime and entry are stable files.
 */
export function resolveCommandLineLauncherTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly runtime: string;
  readonly serverEntry: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): CommandLineLauncherTarget {
  const appImage = input.environment.APPIMAGE;
  const appDir = input.environment.APPDIR;
  if (input.platform === "linux" && appImage && appDir) {
    const relative = Path.relative(appDir, input.serverEntry);
    if (relative && !relative.startsWith("..") && !Path.isAbsolute(relative)) {
      return { kind: "appimage", appImagePath: appImage, serverEntryInAppDir: relative };
    }
  }
  return {
    kind: "direct",
    nodeExecutable: input.runtime,
    serverEntry: input.serverEntry,
    ...(input.platform === "win32"
      ? {
          windowsShim: Path.join(
            Path.dirname(input.serverEntry),
            "..",
            "cli-launcher",
            "bin",
            "bigbud-cli-launcher.exe",
          ),
        }
      : {}),
  };
}

/** POSIX launcher: `exec <runtime> <script> "$@"` so the CLI sees the user's args at argv[2]. */
export function buildCommandLineLauncherScript(input: {
  readonly runtime: string;
  readonly script: string;
}): string {
  return [
    "#!/bin/sh",
    BIGBUD_LAUNCHER_MARKER,
    "# Runs the server CLI bundled with the installed bigbud app.",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(input.runtime)} ${shellQuote(input.script)} "$@"`,
    "",
  ].join("\n");
}

/**
 * AppImage bootstrap module. It must be a real file: `node -e` defines a global `__filename` of
 * "[eval]", which bundled dependencies (e.g. the Copilot SDK's `createRequire`) then misuse.
 */
export function buildAppImageBootstrapModule(serverEntryInAppDir: string): string {
  return [
    BIGBUD_LAUNCHER_BOOTSTRAP_MARKER,
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "const appDir = process.env.APPDIR;",
    "if (!appDir) {",
    '  console.error("bigbud: start the command through the bigbud AppImage.");',
    "  process.exit(1);",
    "}",
    `await import(pathToFileURL(join(appDir, ${JSON.stringify(serverEntryInAppDir)})).href);`,
    "",
  ].join("\n");
}

function hasMarker(path: string, marker: string): boolean {
  try {
    return FS.readFileSync(path, "utf8")
      .split("\n", 3)
      .some((line) => line.replace(/\r$/, "") === marker);
  } catch {
    return false;
  }
}

function isOurLauncher(path: string): boolean {
  return hasMarker(path, BIGBUD_LAUNCHER_MARKER) || hasMarker(path, BIGBUD_WINDOWS_LAUNCHER_MARKER);
}

/** Atomic same-directory replace, so a reader never sees a partial launcher. */
function writeAtomically(path: string, content: string, mode: number): void {
  const temporary = Path.join(Path.dirname(path), `.${Path.basename(path)}.${process.pid}.tmp`);
  FS.writeFileSync(temporary, content, { mode });
  FS.renameSync(temporary, path);
  FS.chmodSync(path, mode);
}

function findOnPath(command: string, pathValue: string, platform: NodeJS.Platform): string | null {
  const windows = platform === "win32";
  const names = windows ? WINDOWS_COMMAND_EXTENSIONS.map((ext) => `${command}${ext}`) : [command];
  for (const directory of pathValue.split(windows ? ";" : ":")) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = Path.join(directory, name);
      try {
        // Windows has no execute bit; existence of a PATHEXT file is what cmd.exe resolves.
        FS.accessSync(candidate, windows ? FS.constants.F_OK : FS.constants.X_OK);
        if (FS.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not present or not executable in this directory.
      }
    }
  }
  return null;
}

/**
 * Create `~/.local/bin/bigbud` (`bigbud.exe` on Windows, the directory uv and pipx also use) the
 * herdr way (D2): only when no other `bigbud` command exists, never editing shell startup files
 * or the Windows user PATH. Our own launcher is refreshed in place.
 */
export function installCommandLineLauncher(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly pathValue: string;
  readonly target: CommandLineLauncherTarget;
  /**
   * Command name: `bigbud` for stable, the release identity's executable name (for example
   * `bigbud-beta`) for prerelease channels, so channels never overwrite each other's launcher.
   */
  readonly commandName?: string;
}): CommandLineLauncherResult {
  const windows = input.platform === "win32";
  if (windows && input.target.kind !== "direct") {
    return { status: "unsupported", reason: "AppImage launchers exist only on Linux." };
  }
  const requiredFiles =
    input.target.kind === "direct"
      ? [input.target.nodeExecutable, input.target.serverEntry]
      : [input.target.appImagePath];
  if (
    input.target.kind === "appimage" &&
    (Path.isAbsolute(input.target.serverEntryInAppDir) ||
      input.target.serverEntryInAppDir.split(/[\\/]/).includes(".."))
  ) {
    return { status: "unsupported", reason: "The AppImage server entry must stay inside the app." };
  }
  for (const required of requiredFiles) {
    if (!Path.isAbsolute(required) || !FS.existsSync(required)) {
      return { status: "unsupported", reason: `The bundled CLI is missing at ${required}.` };
    }
  }
  const binDir = Path.join(input.homeDir, ".local", "bin");
  const commandName = input.commandName ?? "bigbud";
  if (!/^bigbud(-[a-z]+)?$/.test(commandName)) {
    return { status: "unsupported", reason: `Invalid command name ${commandName}.` };
  }
  if (windows && input.target.kind === "direct") {
    return installWindowsCommandLineLauncher({
      homeDir: input.homeDir,
      pathValue: input.pathValue,
      commandName,
      runtime: input.target.nodeExecutable,
      script: input.target.serverEntry,
      shim: input.target.windowsShim ?? "",
    });
  }
  const launcherPath = Path.join(binDir, commandName);
  const onPath = findOnPath(commandName, input.pathValue, input.platform);
  if (onPath && !isOurLauncher(onPath)) return { status: "existing-command", existingPath: onPath };
  const existed = FS.lstatSync(launcherPath, { throwIfNoEntry: false }) !== undefined;
  if (existed && !isOurLauncher(launcherPath)) {
    return { status: "existing-command", existingPath: launcherPath };
  }
  let run: { readonly runtime: string; readonly script: string };
  if (input.target.kind === "direct") {
    run = { runtime: input.target.nodeExecutable, script: input.target.serverEntry };
  } else {
    const bootstrapDir = Path.join(input.homeDir, ".local", "share", "bigbud", "cli");
    const bootstrapPath = Path.join(bootstrapDir, `${commandName}-appimage-bootstrap.mjs`);
    if (
      FS.lstatSync(bootstrapPath, { throwIfNoEntry: false }) !== undefined &&
      !hasMarker(bootstrapPath, BIGBUD_LAUNCHER_BOOTSTRAP_MARKER)
    ) {
      return { status: "unsupported", reason: `Unrecognized file at ${bootstrapPath}.` };
    }
    FS.mkdirSync(bootstrapDir, { recursive: true, mode: 0o755 });
    writeAtomically(
      bootstrapPath,
      buildAppImageBootstrapModule(input.target.serverEntryInAppDir),
      0o644,
    );
    run = { runtime: input.target.appImagePath, script: bootstrapPath };
  }
  const script = buildCommandLineLauncherScript(run);
  if (script === null) {
    return { status: "unsupported", reason: "The app path cannot be used safely from cmd.exe." };
  }
  FS.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  writeAtomically(launcherPath, script, 0o755);
  // Windows paths compare case-insensitively; POSIX paths do not.
  const comparable = (path: string) =>
    windows ? Path.resolve(path).toLowerCase() : Path.resolve(path);
  const onPathDirs = input.pathValue
    .split(windows ? ";" : ":")
    .filter(Boolean)
    .map(comparable);
  return {
    status: existed ? "updated" : "installed",
    launcherPath,
    pathHint: onPathDirs.includes(comparable(binDir))
      ? null
      : windows
        ? `Add ${binDir} to your user Path environment variable, then open a new terminal.`
        : `Add ${binDir} to your PATH, for example: export PATH="$HOME/.local/bin:$PATH"`,
  };
}
