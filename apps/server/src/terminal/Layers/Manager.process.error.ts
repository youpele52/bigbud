import * as Effect from "effect/Effect";

import type { PtyProcess } from "../Services/PTY";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import type { TerminalSessionState } from "./Manager.types";

/** Keep the exact process/lease tracked until a real exit, even if containment signals fail. */
export function observeTerminalProcessError(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  process: PtyProcess,
  runtimeEpoch: number,
): () => void {
  let reported = false;
  const runtimeGeneration = session.runtimeGeneration;
  return (
    process.onError?.((error) => {
      if (reported) return;
      reported = true;
      ctx.runFork(
        Effect.gen(function* () {
          const createdAt = yield* ctx.modifyManagerState((state) => {
            if (
              session.process !== process ||
              session.runtimeEpoch !== runtimeEpoch ||
              session.observedExit?.process === process
            )
              return [null, state] as const;
            session.status = "error";
            session.hasRunningSubprocess = false;
            session.activeAgentProvider = null;
            session.activeAgent = null;
            session.agentIdentityMisses = 0;
            session.updatedAt = nextTerminalTimestamp(session.updatedAt);
            return [session.updatedAt, state] as const;
          });
          if (!createdAt) return;
          yield* ctx.publishEvent({
            type: "error",
            threadId: session.threadId,
            terminalId: session.terminalId,
            runtimeGeneration,
            createdAt,
            message: error.message,
          });
        }),
      );
    }) ?? (() => undefined)
  );
}
