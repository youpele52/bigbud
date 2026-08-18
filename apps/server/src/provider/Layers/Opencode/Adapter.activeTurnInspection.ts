import type { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderActiveTurnInspection } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import { formatOpencodeSdkError } from "./Provider.sdk.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

interface ActiveTurnInspectionDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
}

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
    throw new Error(`${method} failed: ${formatOpencodeSdkError(response.error)}`);
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
        const [statusResponse, questionsResponse, permissionsResponse] = await Promise.all([
          record.client.session.status(),
          record.client.question.list(),
          record.client.permission.list(),
        ]);
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
          record.activeTurnId = undefined;
          record.updatedAt = observedAt;
          record.wasRetrying = false;
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

        const sessionResponse = await record.client.session.get({
          sessionID: record.opencodeSessionId,
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
          throw new Error(`session.get failed: ${formatOpencodeSdkError(sessionResponse.error)}`);
        }
        if (!sessionResponse.data) throw new Error("session.get returned no data.");

        if (record.activeTurnId !== turnId || deps.sessions.get(threadId) !== record) {
          return unavailable();
        }
        record.activeTurnId = undefined;
        record.updatedAt = observedAt;
        record.wasRetrying = false;
        return {
          status: "completed",
          observedAt,
          completionEvidence: { source: "opencode.session.status" },
        };
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: "opencode",
          method: "activeTurnInspection",
          detail: formatOpencodeSdkError(cause),
          cause,
        }),
    });
  };
}
