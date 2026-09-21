import type {
  ModelSelection,
  ProviderKind,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { isLiveProviderSessionIdle } from "../liveProviderSessionIdle.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { startAcceptedTurnLiveness } from "./ProviderService.turnLiveness.ts";

type LivenessOption = Option.Option<ProviderTurnLivenessRepositoryShape>;

export const recordAcceptedSendTurn = Effect.fn("recordAcceptedSendTurn")(function* (input: {
  readonly adapter: {
    readonly provider: ProviderKind;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  };
  readonly directory: ProviderSessionDirectoryShape;
  readonly liveness: LivenessOption;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly sessionEpoch: number;
  readonly resumeCursor?: unknown;
  readonly modelSelection?: ModelSelection;
}) {
  const observedAt = new Date().toISOString();
  const liveSessions = yield* input.adapter.listSessions();
  const live = liveSessions.find((session) => session.threadId === input.threadId);
  if (isLiveProviderSessionIdle(live)) {
    if (Option.isSome(input.liveness)) {
      yield* input.liveness.value
        .claimTerminal({
          threadId: input.threadId,
          turnId: input.turnId,
          provider: input.adapter.provider,
          sessionEpoch: input.sessionEpoch,
          terminalAt: observedAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to claim completed provider turn liveness", {
              threadId: input.threadId,
              turnId: input.turnId,
              error,
            }).pipe(Effect.as(false)),
          ),
        );
    }
    yield* input.directory.upsert({
      threadId: input.threadId,
      provider: input.adapter.provider,
      status: "running",
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      runtimePayload: {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        activeTurnId: null,
        lastRuntimeEvent: "provider.sendTurn",
        lastRuntimeEventAt: observedAt,
      },
    });
    return;
  }

  yield* startAcceptedTurnLiveness(input.liveness, {
    threadId: input.threadId,
    turnId: input.turnId,
    provider: input.adapter.provider,
    sessionEpoch: input.sessionEpoch,
    startedAt: observedAt,
  });
  yield* input.directory.upsert({
    threadId: input.threadId,
    provider: input.adapter.provider,
    status: "running",
    ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    runtimePayload: {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      activeTurnId: input.turnId,
      lastRuntimeEvent: "provider.sendTurn",
      lastRuntimeEventAt: observedAt,
    },
  });
});
