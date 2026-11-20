/**
 * Validated system open for `Open.openPath`: the server-side counterpart of the desktop bridge
 * (`apps/desktop/src/window/shellPathHandlers.ts`), sharing its rules through
 * `@bigbud/shared/systemOpenPath`.
 *
 * Paths must be absolute, exist, and resolve to a regular file or folder. Launchable targets
 * (executables, scripts, installers, app bundles) are revealed in the file manager and never
 * opened; everything else opens with the system default app.
 *
 * @module OpenSystemPath
 */
import * as nodePath from "node:path";

import { OpenError } from "@bigbud/contracts";
import {
  inspectSystemOpenPath,
  type SystemOpenPathInspection,
  type SystemOpenPathRefusal,
} from "@bigbud/shared/systemOpenPath";
import { Effect } from "effect";

import { isOpenError, launchDetached, type EditorLaunch, type LaunchOptions } from "./open.launch";

export type ValidSystemOpenPath = Extract<SystemOpenPathInspection, { ok: true }>;

const REFUSAL_MESSAGES: Record<SystemOpenPathRefusal, string> = {
  "invalid-path": "Cannot open path: it must be an absolute path to a local file or folder.",
  "not-found": "Cannot open path: it does not exist.",
  inaccessible: "Cannot open path: it cannot be accessed.",
  "unsupported-entry": "Cannot open path: only files and folders can be opened.",
};

export function systemOpenRefusalError(reason: SystemOpenPathRefusal): OpenError {
  return new OpenError({ message: REFUSAL_MESSAGES[reason] });
}

/**
 * `explorer.exe` splits unquoted arguments on commas (a file named `x.exe,.txt` would launch
 * `x.exe`), so its path is always quoted verbatim. Windows paths cannot contain `"`.
 */
function quoteForExplorer(path: string): string | null {
  return path.includes('"') ? null : `"${path}"`;
}

/**
 * The file-manager launch that opens `target.realPath` with the system default, or reveals it
 * when it is launchable. Linux reveals by opening the containing folder with `xdg-open`.
 */
export function resolveSystemOpenLaunch(
  target: ValidSystemOpenPath,
  platform: NodeJS.Platform = process.platform,
): EditorLaunch | OpenError {
  const { realPath, launchable } = target;
  switch (platform) {
    case "darwin":
      return { command: "open", args: launchable ? ["-R", realPath] : [realPath] };
    case "win32": {
      const quoted = quoteForExplorer(realPath);
      if (quoted === null) return systemOpenRefusalError("invalid-path");
      return {
        command: "explorer",
        args: [launchable ? `/select,${quoted}` : quoted],
        windowsVerbatimArguments: true,
      };
    }
    default:
      return {
        command: "xdg-open",
        args: [launchable ? nodePath.posix.dirname(realPath) : realPath],
      };
  }
}

/** Validates `rawPath`, then opens it with the system default or reveals it when launchable. */
export const openSystemPath = Effect.fn("openSystemPath")(function* (
  rawPath: string,
  options: LaunchOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const inspection = yield* Effect.tryPromise({
    try: () => inspectSystemOpenPath(rawPath, platform),
    catch: (cause) => new OpenError({ message: "failed to inspect path", cause }),
  });
  if (!inspection.ok) return yield* systemOpenRefusalError(inspection.reason);

  const launch = resolveSystemOpenLaunch(inspection, platform);
  if (isOpenError(launch)) return yield* launch;
  yield* launchDetached(launch, options);
});
