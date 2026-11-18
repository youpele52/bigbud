import type { RuntimeMode } from "./config.ts";

import { lstat } from "node:fs/promises";
import * as Effect from "effect/Effect";

export type TerminalShellInstallEvidence = "fresh" | "existing-or-uncertain";

/** Capture before any mkdir, including cwd creation. A dangling link is prior state. */
export const captureTerminalShellInstallEvidence = Effect.fn("captureTerminalShellInstallEvidence")(
  (stateDir: string, mode: RuntimeMode, inspect: (path: string) => Promise<unknown> = lstat) =>
    Effect.promise(async (): Promise<TerminalShellInstallEvidence> => {
      // Only web installs have reliable fresh-root shell migration evidence.
      if (mode !== "web") return "existing-or-uncertain";
      try {
        await inspect(stateDir);
        return "existing-or-uncertain";
      } catch (cause) {
        return typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
          ? "fresh"
          : "existing-or-uncertain";
      }
    }),
);
