import * as Effect from "effect/Effect";
import { RemoteAgentPtyError } from "../../remote-agent/remoteAgentPtyClient.types";

import { NativeSshPtyHostLostError, type PtyProcess } from "../Services/PTY";
import { publishTerminalHostNotice, terminalHostLostNotice } from "./Manager.hostLifecycle.ts";
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
  let lastReplayGap: string | undefined;
  const runtimeGeneration = session.runtimeGeneration;
  return (
    process.onError?.((error) => {
      if (error instanceof RemoteAgentPtyError && error.code === "PTY_REPLAY_GAP") {
        // Replay loss is a distinct observation, not the lifetime fatal-error
        // latch. Keep only the last gap; repeated attach replies for the same
        // retained suffix must not spam the user or hide later loss.
        if (lastReplayGap === error.message) return;
        lastReplayGap = error.message;
      } else {
        if (reported) return;
        reported = true;
      }
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
            if (error instanceof NativeSshPtyHostLostError) {
              // Keep the exact observer's shutdown fence but do not advertise a live PID or
              // manufacture a child exit event from loss of the owner channel.
              session.endedReason = "host-lost";
              session.pid = null;
            }
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
          if (error instanceof NativeSshPtyHostLostError)
            yield* publishTerminalHostNotice(ctx.hostHub, terminalHostLostNotice(session));
        }),
      );
    }) ?? (() => undefined)
  );
}
