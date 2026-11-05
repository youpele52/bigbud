/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";

import {
  EDITORS,
  OpenError,
  OpenPathInput,
  TERMINAL_APPLICATIONS,
  type EditorId,
  type TerminalApplicationId,
} from "@bigbud/contracts";
import { ServiceMap, Effect, Layer } from "effect";
import {
  hasDarwinInstallationEvidence,
  hasPlatformInstallationEvidence,
  resolveDarwinEditorApp,
  resolveWin32EditorExecutable,
} from "./open.installation";
import { hasTargetPosition, resolveEditorArgs } from "./open.editor";
import { resolveCommandPath, type CommandAvailabilityOptions } from "./commandPath";

// ==============================
// Definitions
// ==============================

export { OpenError };

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

export interface OpenInTerminalInput {
  readonly cwd: string;
  readonly terminal: TerminalApplicationId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): string | null {
  for (const command of commands) {
    if (isCommandAvailable(command, options)) {
      return command;
    }
  }
  return null;
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  return resolveCommandPath(command, options) !== null;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      const command = fileManagerCommandForPlatform(platform);
      if (isCommandAvailable(command, { platform, env })) {
        available.push(editor.id);
      }
      continue;
    }

    if (hasPlatformInstallationEvidence(editor, platform, env)) {
      available.push(editor.id);
      continue;
    }

    if (platform === "darwin" && hasDarwinInstallationEvidence(editor)) {
      continue;
    }

    const command = resolveAvailableCommand(editor.commands, { platform, env });
    if (command !== null) {
      available.push(editor.id);
    }
  }

  return available;
}

export function resolveAvailableTerminals(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<TerminalApplicationId> {
  return TERMINAL_APPLICATIONS.filter((terminal) => {
    if (terminal.id === "windows-terminal" && platform !== "win32") return false;
    if (
      ["gnome-terminal", "konsole", "xfce4-terminal"].includes(terminal.id) &&
      platform !== "linux"
    ) {
      return false;
    }
    return resolveAvailableCommand(terminal.commands, { platform, env }) !== null;
  }).map((terminal) => terminal.id);
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;

  /** Open a workspace path in a supported external terminal. */
  readonly openInTerminal: (input: OpenInTerminalInput) => Effect.Effect<void, OpenError>;

  /**
   * Open a file or directory with the system's default application.
   *
   * Uses the platform's file manager command (`open` on macOS, `xdg-open` on Linux,
   * `explorer` on Windows) so the OS resolves the default app for the given path.
   */
  readonly openPath: (input: OpenPathInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.annotateCurrentSpan({
    "open.editor": input.editor,
    "open.cwd": input.cwd,
    "open.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (platform === "darwin") {
    const appPath = resolveDarwinEditorApp(editorDef, env);
    if (appPath !== null) {
      return {
        command: "open",
        args: hasTargetPosition(input.cwd)
          ? ["-a", appPath, "--args", ...resolveEditorArgs(editorDef, input.cwd)]
          : ["-a", appPath, input.cwd],
      };
    }
  }

  if (platform === "win32") {
    const executablePath = resolveWin32EditorExecutable(editorDef, env);
    if (executablePath !== null) {
      return {
        command: executablePath,
        args: resolveEditorArgs(editorDef, input.cwd),
      };
    }
  }

  if (editorDef.commands) {
    const command =
      resolveAvailableCommand(editorDef.commands, { platform, env }) ?? editorDef.commands[0];
    return {
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const resolveTerminalLaunch = Effect.fn("resolveTerminalLaunch")(function* (
  input: OpenInTerminalInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const terminal = TERMINAL_APPLICATIONS.find((candidate) => candidate.id === input.terminal);
  if (!terminal) return yield* new OpenError({ message: `Unknown terminal: ${input.terminal}` });

  const command =
    resolveAvailableCommand(terminal.commands, { platform, env }) ?? terminal.commands[0];
  return { command, args: terminal.cwdArgs(input.cwd) };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        const isWin32 = process.platform === "win32";
        child = spawn(
          launch.command,
          isWin32 ? launch.args.map((a) => `"${a}"`) : [...launch.args],
          {
            detached: true,
            stdio: "ignore",
            shell: isWin32,
          },
        );
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
    openInTerminal: (input) => Effect.flatMap(resolveTerminalLaunch(input), launchDetached),
    openPath: (input) =>
      launchDetached({
        command: fileManagerCommandForPlatform(process.platform),
        args: [input.path],
      }),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
