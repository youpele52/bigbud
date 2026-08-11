import { Effect } from "effect";

import type { ActivePiSession } from "./Adapter.types.ts";
import type { PiRpcSessionState } from "./RpcProcess.ts";

const RECOVERY_RETRY_DELAY = "100 millis";
const RECOVERY_MAX_ATTEMPTS = 4;

export function recoverMissingPiAgentEnd(input: {
  readonly session: ActivePiSession;
  readonly settle: () => Effect.Effect<void>;
  readonly reportExhausted?: (input: {
    readonly threadId: ActivePiSession["threadId"];
    readonly turnId: ActivePiSession["activeTurnId"];
    readonly attempts: number;
    readonly class: "missing_agent_end_recovery_exhausted" | "state_query_failed";
  }) => Effect.Effect<void>;
}) {
  const boundary = input.session.completedTurnBoundary;
  if (!boundary || !input.session.agentRunning) return Effect.void;
  const reportExhausted = input.reportExhausted ?? (() => Effect.void);
  const token = Symbol("pi-missing-agent-end");
  input.session.missingAgentEndRecoveryToken = token;

  const recover = Effect.fn("recoverMissingPiAgentEnd")(function* () {
    if (
      input.session.completedTurnBoundary !== boundary ||
      !input.session.agentRunning ||
      input.session.missingAgentEndRecoveryToken !== token
    ) {
      return;
    }
    let hadStateResponse = false;
    for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      if (input.session.missingAgentEndRecoveryToken !== token) return;
      const state = yield* Effect.tryPromise({
        try: () => input.session.process.request<PiRpcSessionState>({ type: "get_state" }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      hadStateResponse ||= state !== undefined;
      if (
        input.session.completedTurnBoundary !== boundary ||
        !input.session.agentRunning ||
        input.session.missingAgentEndRecoveryToken !== token
      ) {
        return;
      }
      if (state?.data?.isStreaming === false) {
        input.session.missingAgentEndRecoveryToken = undefined;
        return yield* input.settle();
      }
      yield* Effect.sleep(RECOVERY_RETRY_DELAY);
      if (input.session.missingAgentEndRecoveryToken !== token) return;
    }
    if (input.session.missingAgentEndRecoveryToken !== token) return;
    input.session.missingAgentEndRecoveryToken = undefined;
    yield* reportExhausted({
      threadId: input.session.threadId,
      turnId: input.session.activeTurnId,
      attempts: RECOVERY_MAX_ATTEMPTS,
      class: hadStateResponse ? "missing_agent_end_recovery_exhausted" : "state_query_failed",
    });
  });

  return recover().pipe(Effect.forkDetach, Effect.asVoid);
}
