import type { OrchestrationThread } from "@bigbud/contracts";
import {
  PROVIDER_CHECKING_SESSION_REASON,
  PROVIDER_LOST_SESSION_REASON,
  PROVIDER_STALLED_SESSION_REASON,
} from "@bigbud/contracts/constants/providerRuntime.constant";
import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect, Option } from "effect";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

export const PROVIDER_TURN_SILENCE_THRESHOLD_MS = 90_000;
export const PROVIDER_TURN_INSPECTION_TIMEOUT_MS = 10_000;
export const PROVIDER_TURN_MAX_INSPECTION_FAILURES = 3;

const INSPECTION_BACKOFF_MS = [0, 15_000, 30_000, 60_000] as const;
const STATUS_UNCONFIRMED_ERROR =
  "bigbud cannot confirm whether the provider is still working. No prompt was resent.";
const LOST_SESSION_ERROR =
  "The provider no longer reports this turn or its session. You can stop it or check again.";

function shouldInspect(liveness: ProviderTurnLiveness, nowMs: number): boolean {
  const progressAt = Date.parse(liveness.lastMeaningfulProgressAt);
  if (
    liveness.inspectionStatus !== "checking" &&
    (!Number.isFinite(progressAt) || nowMs - progressAt < PROVIDER_TURN_SILENCE_THRESHOLD_MS)
  ) {
    return false;
  }
  const inspectedAt = Date.parse(liveness.lastInspectionAt ?? "");
  const backoff =
    INSPECTION_BACKOFF_MS[
      Math.min(liveness.consecutiveInspectionFailures, INSPECTION_BACKOFF_MS.length - 1)
    ] ?? INSPECTION_BACKOFF_MS.at(-1)!;
  return !Number.isFinite(inspectedAt) || nowMs - inspectedAt >= backoff;
}

function projectHealthState(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly thread: OrchestrationThread;
  readonly liveness: ProviderTurnLiveness;
  readonly status: "running" | "ready" | "error";
  readonly reason: string | null;
  readonly lastError: string | null;
  readonly occurredAt: string;
  readonly terminal?: boolean;
}) {
  const current = input.thread.session;
  if (!current || current.activeTurnId !== input.liveness.turnId) return Effect.void;
  return input.orchestrationEngine
    .dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-turn-health"),
      threadId: input.thread.id,
      session: {
        ...current,
        status: input.status,
        activeTurnId: input.terminal ? null : input.liveness.turnId,
        reason: input.reason,
        lastError: input.lastError,
        updatedAt: input.occurredAt,
      },
      createdAt: input.occurredAt,
    })
    .pipe(Effect.asVoid);
}

export function superviseProviderTurns(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly now?: () => Date;
}) {
  return Effect.gen(function* () {
    const now = input.now?.() ?? new Date();
    const nowMs = now.getTime();
    const occurredAt = now.toISOString();
    const livenessRows = yield* input.providerService.listActiveTurnLiveness();
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread]));

    yield* Effect.forEach(
      livenessRows.filter((entry) => shouldInspect(entry, nowMs)),
      (liveness) =>
        Effect.gen(function* () {
          const thread = threadsById.get(liveness.threadId);
          if (!thread || thread.session?.activeTurnId !== liveness.turnId) return;

          yield* input.providerService.recordTurnInspection({
            threadId: liveness.threadId,
            turnId: liveness.turnId,
            observedAt: occurredAt,
            status: "checking",
            failed: false,
          });
          yield* projectHealthState({
            orchestrationEngine: input.orchestrationEngine,
            thread,
            liveness,
            status: "error",
            reason: PROVIDER_CHECKING_SESSION_REASON,
            lastError: STATUS_UNCONFIRMED_ERROR,
            occurredAt,
          });

          const inspection = yield* input.providerService
            .inspectActiveTurn({ threadId: liveness.threadId, turnId: liveness.turnId })
            .pipe(Effect.timeoutOption(PROVIDER_TURN_INSPECTION_TIMEOUT_MS), Effect.option);
          const result = Option.getOrUndefined(Option.flatten(inspection));
          const inspectionStatus = result?.status ?? "timed-out";
          const failedInspection = result === undefined || result.status === "unavailable";
          yield* input.providerService.recordTurnInspection({
            threadId: liveness.threadId,
            turnId: liveness.turnId,
            observedAt: result?.observedAt ?? occurredAt,
            status: inspectionStatus,
            failed: failedInspection,
          });

          if (result?.status === "completed" || result?.status === "failed") {
            const claimed = yield* input.providerService.claimTurnTerminal({
              threadId: liveness.threadId,
              turnId: liveness.turnId,
              provider: liveness.provider,
              terminalAt: occurredAt,
            });
            if (claimed) {
              const failed = result.status === "failed";
              yield* projectHealthState({
                orchestrationEngine: input.orchestrationEngine,
                thread,
                liveness,
                status: failed ? "error" : "ready",
                reason: null,
                lastError: failed
                  ? (result.errorEvidence?.detail ??
                    "The provider authoritatively reported that the turn failed.")
                  : null,
                occurredAt,
                terminal: true,
              });
            }
            return;
          }

          if (result?.status === "running") {
            return;
          }
          if (result?.status === "waiting-for-user") return;

          if (result?.status === "missing") {
            yield* projectHealthState({
              orchestrationEngine: input.orchestrationEngine,
              thread,
              liveness,
              status: "error",
              reason: PROVIDER_LOST_SESSION_REASON,
              lastError: result.errorEvidence?.detail ?? LOST_SESSION_ERROR,
              occurredAt,
            });
            return;
          }

          if (liveness.consecutiveInspectionFailures + 1 >= PROVIDER_TURN_MAX_INSPECTION_FAILURES) {
            yield* projectHealthState({
              orchestrationEngine: input.orchestrationEngine,
              thread,
              liveness,
              status: "error",
              reason: PROVIDER_STALLED_SESSION_REASON,
              lastError: STATUS_UNCONFIRMED_ERROR,
              occurredAt,
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider turn supervision failed", {
              threadId: liveness.threadId,
              turnId: liveness.turnId,
              cause,
            }),
          ),
        ),
      { concurrency: 4 },
    );
  });
}
