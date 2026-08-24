import type { ProviderKind, ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option, Stream } from "effect";

import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { isMeaningfulProviderProgress, isTerminalProviderEvent } from "../providerTurnLiveness.ts";

type LivenessOption = Option.Option<ProviderTurnLivenessRepositoryShape>;

export function observeProviderRuntimeEvent(liveness: LivenessOption, event: ProviderRuntimeEvent) {
  const observation = !Option.isSome(liveness)
    ? Effect.succeed(true)
    : isTerminalProviderEvent(event) && event.turnId
      ? liveness.value.claimTerminal({
          threadId: event.threadId,
          turnId: event.turnId,
          provider: event.provider,
          sessionEpoch: event.sessionEpoch ?? 0,
          terminalAt: event.createdAt,
        })
      : liveness.value
          .observeEvent(event, isMeaningfulProviderProgress(event))
          .pipe(Effect.as(true));
  return observation.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to persist provider turn liveness event", {
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        eventType: event.type,
        error,
      }).pipe(Effect.as(true)),
    ),
  );
}

export function monitorProviderRuntimeEvents(input: {
  readonly adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  readonly liveness: LivenessOption;
  readonly process: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  return Effect.forEach(input.adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, input.process).pipe(
      Effect.onExit(() => recordMonitoringLoss(input.liveness, adapter.provider)),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider event monitor exited", { provider: adapter.provider, cause }),
      ),
      Effect.forkScoped,
    ),
  ).pipe(Effect.asVoid);
}

function recordMonitoringLoss(liveness: LivenessOption, provider: ProviderKind) {
  if (!Option.isSome(liveness)) return Effect.void;
  return liveness.value
    .markMonitoringLost({ provider, observedAt: new Date().toISOString() })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to record provider monitoring loss", { provider, error }),
      ),
    );
}

export function makeTurnLivenessOperations(
  liveness: LivenessOption,
): Pick<
  ProviderServiceShape,
  "listActiveTurnLiveness" | "recordTurnInspection" | "claimTurnTerminal"
> {
  return {
    listActiveTurnLiveness: () =>
      Option.isSome(liveness)
        ? liveness.value
            .listActive()
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to list provider turn liveness", { error }).pipe(
                  Effect.as([]),
                ),
              ),
            )
        : Effect.succeed([]),
    recordTurnInspection: (inspection) =>
      Option.isSome(liveness)
        ? liveness.value.recordInspection(inspection).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to persist provider turn inspection", {
                ...inspection,
                error,
              }),
            ),
          )
        : Effect.void,
    claimTurnTerminal: (terminal) =>
      Option.isSome(liveness)
        ? liveness.value.claimTerminal(terminal).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to claim provider turn terminal transition", {
                ...terminal,
                error,
              }).pipe(Effect.as(false)),
            ),
          )
        : Effect.succeed(true),
  };
}

export function startAcceptedTurnLiveness(
  liveness: LivenessOption,
  input: {
    threadId: ThreadId;
    turnId: TurnId;
    provider: ProviderKind;
    sessionEpoch: number;
    startedAt: string;
  },
) {
  if (!Option.isSome(liveness)) return Effect.void;
  return liveness.value
    .startTurn(input)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to persist accepted provider turn liveness", { ...input, error }),
      ),
    );
}

export function markProviderTurnTerminal(
  liveness: LivenessOption,
  input: { threadId: ThreadId; turnId?: TurnId; sessionEpoch?: number; terminalAt: string },
) {
  return Option.isSome(liveness)
    ? liveness.value
        .markTerminal(input)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist provider turn settlement", { ...input, error }),
          ),
        )
    : Effect.void;
}
