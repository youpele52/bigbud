import { lstat } from "node:fs/promises";
import * as Effect from "effect/Effect";

export type TerminalShellInstallEvidence = "fresh" | "existing-or-uncertain";

/** Capture before any mkdir, including cwd creation. A dangling link is prior state. */
export const captureTerminalShellInstallEvidence = Effect.fn("captureTerminalShellInstallEvidence")(
  (
    stateDir: string,
    mode: "web" | "desktop",
    inspect: (path: string) => Promise<unknown> = lstat,
  ) =>
    Effect.promise(async (): Promise<TerminalShellInstallEvidence> => {
      // Electron may reuse legacy state outside this root. No reliable legacy evidence is supplied.
      if (mode === "desktop") return "existing-or-uncertain";
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
