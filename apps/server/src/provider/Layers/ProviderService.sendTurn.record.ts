import type {
  ModelSelection,
  ProviderKind,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import { isLiveProviderSessionIdle } from "../liveProviderSessionIdle.ts";
import type {
  ProviderSessionDirectoryShape,
  ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { startAcceptedTurnLiveness } from "./ProviderService.turnLiveness.ts";
import { readV2CursorSelection } from "./ProviderService.modelSelection.v2.ts";

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
  /**
   * Marks the dispatch attempt `provider-acknowledged` in one transaction with the liveness
   * and binding writes. When it fails, the attempt stays `may-have-been-sent` (the
   * conservative state), and liveness (best effort) and the binding are written without it,
   * as before.
   */
  readonly acknowledge?: (
    writes: Effect.Effect<void, PersistenceSqlError | ProviderSessionDirectoryWriteError>,
  ) => Effect.Effect<void, PersistenceSqlError | ProviderSessionDirectoryWriteError>;
}) {
  const observedAt = new Date().toISOString();
  const modelSelection =
    input.adapter.provider === "opencodeV2" &&
    input.resumeCursor !== null &&
    typeof input.resumeCursor === "object" &&
    "model" in input.resumeCursor
      ? ((yield* readV2CursorSelection(input.resumeCursor)) ?? input.modelSelection)
      : input.modelSelection;
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
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        activeTurnId: null,
        lastRuntimeEvent: "provider.sendTurn",
        lastRuntimeEventAt: observedAt,
      },
    });
    // The provider accepted and already finished the turn.
    if (input.acknowledge !== undefined) {
      yield* input.acknowledge(Effect.void).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to record provider acknowledgement", {
            threadId: input.threadId,
            turnId: input.turnId,
            error,
          }),
        ),
      );
    }
    return;
  }

  const livenessInput = {
    threadId: input.threadId,
    turnId: input.turnId,
    provider: input.adapter.provider,
    sessionEpoch: input.sessionEpoch,
    startedAt: observedAt,
  };
  const upsertBinding = input.directory.upsert({
    threadId: input.threadId,
    provider: input.adapter.provider,
    status: "running",
    ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    runtimePayload: {
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      activeTurnId: input.turnId,
      lastRuntimeEvent: "provider.sendTurn",
      lastRuntimeEventAt: observedAt,
    },
  });
  if (input.acknowledge !== undefined) {
    // Without a liveness repository the binding alone rides with the acknowledgement, so the
    // attempt never stays `may-have-been-sent` for a turn the provider accepted.
    const writes = Option.isSome(input.liveness)
      ? input.liveness.value.startTurn(livenessInput).pipe(Effect.andThen(upsertBinding))
      : upsertBinding;
    const acknowledged = yield* input.acknowledge(writes).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to record provider acknowledgement with turn liveness", {
          threadId: input.threadId,
          turnId: input.turnId,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (acknowledged) return;
  }
  // Without the acknowledgement (or after it failed and rolled back), turn liveness is still
  // started best effort before the binding, exactly as before recovery intents existed.
  yield* startAcceptedTurnLiveness(input.liveness, livenessInput);
  yield* upsertBinding;
});
