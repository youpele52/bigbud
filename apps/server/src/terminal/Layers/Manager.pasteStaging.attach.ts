import path from "node:path";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  TERMINAL_PASTE_MAX_FILE_MB,
  terminalPasteMaxFileBytes,
} from "@bigbud/contracts/core/settings.terminalPaste.ts";
import type { TerminalManagerShape } from "../Services/Manager";
import { LocalPasteStore } from "./Manager.pasteStaging.local.ts";
import { makeTerminalPasteStaging } from "./Manager.pasteStaging.ts";
import type { RemotePasteAgentResolver } from "./Manager.pasteStaging.target.ts";

const RECONCILE_INTERVAL = "1 minute";

/**
 * Adds paste staging to a terminal manager: staged files follow their terminal's lifetime
 * (close and restart release them), with a TTL sweep at startup and a periodic reconcile.
 */
export const withTerminalPasteStaging = Effect.fn("terminal.withPasteStaging")(function* (
  manager: TerminalManagerShape,
  input: {
    readonly stateDir: string;
    readonly maxFileMb: () => number | undefined;
    readonly remote: RemotePasteAgentResolver | undefined;
  },
) {
  const local = new LocalPasteStore(path.join(input.stateDir, "terminal-paste"));
  const staging = makeTerminalPasteStaging({
    local,
    snapshot: manager.snapshot,
    maxFileBytes: () =>
      terminalPasteMaxFileBytes(input.maxFileMb() ?? TERMINAL_PASTE_MAX_FILE_MB.default),
    remote: input.remote,
  });
  yield* Effect.tryPromise(() => local.sweep()).pipe(
    Effect.tapError((cause) => Effect.logWarning("terminal paste sweep failed", { cause })),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* staging.reconcile.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)),
    Effect.forkScoped,
  );
  return {
    ...manager,
    stagePasteFile: staging.stage,
    close: (closeInput) =>
      manager
        .close(closeInput)
        .pipe(Effect.tap(() => staging.release(closeInput.threadId, closeInput.terminalId))),
    restart: (restartInput) =>
      manager
        .restart(restartInput)
        .pipe(Effect.tap(() => staging.release(restartInput.threadId, restartInput.terminalId))),
  } satisfies TerminalManagerShape;
});
