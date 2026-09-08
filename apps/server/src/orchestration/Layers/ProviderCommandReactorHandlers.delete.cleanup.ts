export function resolveDeletionRequestMode(
  requestedMode: "single" | "subtree" | undefined,
): "single" | "subtree" {
  return requestedMode ?? "subtree";
}

export function describeRuntimeCleanupFailures(
  failures: ReadonlyArray<{
    readonly step: "provider" | "browser" | "terminal" | "shell";
    readonly detail: string;
  }>,
): string {
  return failures.map((failure) => failure.step).join(", ");
}

const STEP_TIMEOUT = Duration.seconds(15);

function runCleanupStepOnce<A, E, R>(
  step: "provider" | "browser" | "terminal" | "shell",
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(
    Effect.timeout(STEP_TIMEOUT),
    Effect.exit,
    Effect.map((exit) =>
      exit._tag === "Failure"
        ? { ok: false as const, step, detail: Cause.pretty(exit.cause) }
        : { ok: true as const, step },
    ),
  );
}

export function runCleanupStep<A, E, R>(
  step: "provider" | "browser" | "terminal" | "shell",
  effect: () => Effect.Effect<A, E, R>,
) {
  return runCleanupStepOnce(step, effect()).pipe(
    Effect.flatMap((first) =>
      first.ok ? Effect.succeed(first) : runCleanupStepOnce(step, effect()),
    ),
  );
}

export function makeStoppedDeletionSession(input: {
  readonly threadId: ThreadId;
  readonly occurredAt: string;
  readonly threadSession: OrchestrationThread["session"];
  readonly liveSession: ProviderSession | undefined;
}): OrchestrationSession {
  return {
    threadId: input.threadId,
    status: "stopped",
    providerName: input.threadSession?.providerName ?? input.liveSession?.provider ?? null,
    runtimeMode:
      input.threadSession?.runtimeMode ?? input.liveSession?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: input.threadSession?.lastError ?? input.liveSession?.lastError ?? null,
    updatedAt: input.occurredAt,
  };
}

export function readFinalizeReceiptStatus(sql: SqlClient.SqlClient, commandId: string) {
  return sql<{ readonly status: string }>`
    SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}
  `;
}
export function hydrateStoredDirectCleanupResources(
  config: ServerConfigShape,
  resources: ReadonlyArray<Omit<DirectCleanupResource, "root"> & { readonly pageOrdinal: number }>,
) {
  return resources.map((resource) => ({
    ...resource,
    root: resourceRoot(config, resource.kind),
  }));
}
export function appendDeletionFailureActivity(
  orchestrationEngine: OrchestrationEngineShape,
  input: { readonly threadId: ThreadId; readonly createdAt: string; readonly detail: string },
) {
  return orchestrationEngine.dispatch({
    type: "thread.activity.append",
    commandId: serverCommandId("thread-delete-failed-activity"),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(crypto.randomUUID()),
      tone: "error",
      kind: "thread.delete.failed",
      summary: "Thread deletion failed",
      payload: { detail: input.detail },
      turnId: null,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });
}
import {
  DEFAULT_RUNTIME_MODE,
  EventId,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
  type ThreadId,
} from "@bigbud/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { Cause, Duration, Effect } from "effect";
import type { ServerConfigShape } from "../../startup/config.ts";
import type { DirectCleanupResource } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";
import { resourceRoot } from "../../deletion/Layers/EntityPurge.resources.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
