import type { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderActiveTurnInspection } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import { formatManagedServerSdkError } from "../../managedServerProviderDiscovery.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { runWithAbortableDeadline } from "./Adapter.requestDeadline.ts";

interface ActiveTurnInspectionDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
  /** Recovery probes must not settle local state; the supervisor owns settlement. */
  readonly settleCompleted?: boolean;
  readonly now?: () => number;
  readonly finalizationDeadlineMs?: number;
  readonly requestDeadlineMs?: number;
}

export const OPENCODE_FINALIZATION_DEADLINE_MS = 30_000;
const OPENCODE_INSPECTION_REQUEST_DEADLINE_MS = 10_000;

function unavailable(): ProviderActiveTurnInspection {
  return {
    status: "unavailable",
    observedAt: new Date().toISOString(),
    errorEvidence: {
      source: "opencode.active-turn-inspection",
      detail: "The native OpenCode session identity is not available in this server process.",
    },
  };
}

function terminalIngestionPending(observedAt: string): ProviderActiveTurnInspection {
  return {
    status: "running",
    observedAt,
    completionEvidence: {
      source: "opencode.prompt.terminal-ingestion-pending",
      detail: "Canonical completion events are queued for runtime ingestion.",
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "_tag" in error && error._tag === "NotFoundError"
  );
}

function requireData<T>(
  response: { readonly data?: T; readonly error?: unknown },
  method: string,
): NonNullable<T> {
  if (response.error) {
    throw new Error(`${method} failed: ${formatManagedServerSdkError(response.error)}`);
  }
  if (response.data === undefined) {
    throw new Error(`${method} returned no data.`);
  }
  return response.data as NonNullable<T>;
}

export function makeActiveTurnInspection(deps: ActiveTurnInspectionDeps) {
  return (threadId: ThreadId, turnId: TurnId) => {
    const record = deps.sessions.get(threadId);
    if (!record || record.activeTurnId !== turnId) return Effect.succeed(unavailable());

    return Effect.tryPromise({
      try: async (): Promise<ProviderActiveTurnInspection> => {
        const requestDeadlineMs = deps.requestDeadlineMs ?? OPENCODE_INSPECTION_REQUEST_DEADLINE_MS;
        const [statusResponse, questionsResponse, permissionsResponse] = await Promise.all([
          runWithAbortableDeadline({
            operation: "OpenCode session.status",
            timeoutMs: requestDeadlineMs,
            run: (signal) => record.client.session.status(undefined, { signal }),
          }),
          runWithAbortableDeadline({
            operation: "OpenCode question.list",
            timeoutMs: requestDeadlineMs,
            run: (signal) => record.client.question.list(undefined, { signal }),
          }),
          runWithAbortableDeadline({
            operation: "OpenCode permission.list",
            timeoutMs: requestDeadlineMs,
            run: (signal) => record.client.permission.list(undefined, { signal }),
          }),
        ]);
        if (record.activeTurnId !== turnId || deps.sessions.get(threadId) !== record) {
          return unavailable();
        }
        const statuses = requireData(statusResponse, "session.status");
        const questions = requireData(questionsResponse, "question.list");
        const permissions = requireData(permissionsResponse, "permission.list");
        const observedAt = new Date().toISOString();
        const nativeStatus = statuses[record.opencodeSessionId];
        const nativeStatusType = (nativeStatus as { readonly type?: unknown } | undefined)?.type;

        if (
          questions.some((question) => question.sessionID === record.opencodeSessionId) ||
          permissions.some((permission) => permission.sessionID === record.opencodeSessionId)
        ) {
          return {
            status: "waiting-for-user",
            observedAt,
            completionEvidence: { source: "opencode.pending-user-request" },
          };
        }

        if (nativeStatusType === "busy" || nativeStatusType === "retry") {
          return {
            status: "running",
            observedAt,
            completionEvidence: {
              source: "opencode.session.status",
              detail:
                nativeStatus?.type === "retry"
                  ? `Native session is retrying (attempt ${nativeStatus.attempt}).`
                  : "Native session is busy.",
            },
          };
        }

        if (nativeStatusType === "idle") {
          if (record.promptTerminalEventsEnqueuedTurnId === turnId) {
            return terminalIngestionPending(observedAt);
          }
          if (record.activeTurnId !== turnId) return unavailable();
          if (record.activeTurnId === turnId && record.promptTurnId === turnId) {
            if (deps.settleCompleted === false) {
              return {
                status: "running",
                observedAt,
                completionEvidence: {
                  source: "opencode.prompt.final-output",
                  detail: "The local prompt is still collecting its final output.",
                },
              };
            }
            const nowMs = deps.now?.() ?? Date.now();
            record.promptFinalizationStartedAtMs ??= nowMs;
            const deadlineMs = deps.finalizationDeadlineMs ?? OPENCODE_FINALIZATION_DEADLINE_MS;
            let recoveryError: unknown;
            try {
              const recovered = await record.recoverPromptCompletion?.(turnId);
              if (recovered || record.promptTerminalEventsEnqueuedTurnId === turnId) {
                return terminalIngestionPending(observedAt);
              }
              if (record.activeTurnId !== turnId) return unavailable();
            } catch (cause) {
              recoveryError = cause;
            }
            if (nowMs - record.promptFinalizationStartedAtMs >= deadlineMs) {
              const detail = recoveryError
                ? `OpenCode became idle, but final output recovery failed: ${formatManagedServerSdkError(recoveryError)}`
                : "OpenCode became idle, but final output did not become available before the recovery deadline.";
              record.activeTurnId = undefined;
              record.promptTurnId = undefined;
              record.promptSettlementTurnId = undefined;
              record.promptTerminalEventsEnqueuedTurnId = undefined;
              record.recoverPromptCompletion = undefined;
              record.promptStartedAtMs = undefined;
              record.promptFinalizationStartedAtMs = undefined;
              record.lastError = detail;
              record.updatedAt = observedAt;
              return {
                status: "failed",
                observedAt,
                errorEvidence: {
                  source: "opencode.prompt.final-output-timeout",
                  detail,
                },
              };
            }
            if (recoveryError) throw recoveryError;
            return {
              status: "running",
              observedAt,
              completionEvidence: {
                source: "opencode.prompt.final-output",
                detail: "The local prompt is still collecting its final output.",
              },
            };
          }
          if (deps.settleCompleted !== false) {
            record.activeTurnId = undefined;
            record.updatedAt = observedAt;
            record.wasRetrying = false;
          }
          return {
            status: "completed",
            observedAt,
            completionEvidence: {
              source: "opencode.session.status",
              detail: "Native session is idle.",
            },
          };
        }

        if (typeof nativeStatusType === "string") {
          return {
            status: "unavailable",
            observedAt,
            errorEvidence: {
              source: "opencode.session.status",
              detail: `Unexpected native session status: ${nativeStatusType}.`,
            },
          };
        }

        const sessionResponse = await runWithAbortableDeadline({
          operation: "OpenCode session.get",
          timeoutMs: requestDeadlineMs,
          run: (signal) =>
            record.client.session.get({ sessionID: record.opencodeSessionId }, { signal }),
        });
        if (sessionResponse.error) {
          if (isNotFound(sessionResponse.error)) {
            return {
              status: "missing",
              observedAt,
              errorEvidence: {
                source: "opencode.session.get",
                detail: "The native OpenCode session no longer exists.",
              },
            };
          }
          throw new Error(
            `session.get failed: ${formatManagedServerSdkError(sessionResponse.error)}`,
          );
        }
        if (!sessionResponse.data) throw new Error("session.get returned no data.");

        if (record.activeTurnId !== turnId || deps.sessions.get(threadId) !== record) {
          return unavailable();
        }
        return {
          status: "unavailable",
          observedAt,
          errorEvidence: {
            source: "opencode.session.get",
            detail: "The native session exists, but its current turn state is unavailable.",
          },
        };
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: "opencode",
          method: "activeTurnInspection",
          detail: formatManagedServerSdkError(cause),
          cause,
        }),
    });
  };
}
