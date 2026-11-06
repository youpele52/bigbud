import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const Text = Schema.String.check(Schema.isMinLength(1));
const Step = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("opencodeV2"),
    threadId: Text,
    nativeSessionId: Text,
    storageIdentity: Text,
    sourceDirectory: Text,
    destinationDirectory: Text,
    phase: Schema.Literals(["prepared", "dispatched", "verified"]),
    expectedIdentity: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({
    provider: Schema.Literal("muse"),
    threadId: Text,
    nativeSessionId: Text,
    phase: Schema.Literal("archive-ready"),
  }),
]);
export type ProjectWorkspaceNativeStep = typeof Step.Type;
const decodeSteps = Schema.decodeUnknownSync(Schema.Array(Step));

const failure = (detail: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "project.reconfigure",
    detail,
  });

/** Durable inspection only: this boundary has no move/start/prompt/replay callback.
 * Recreating this service after restart reads the same journal and preserves admission fences.
 * A native session still at its source is NOT retried; it requires explicit recovery handling.
 */
export function reconcileProjectWorkspaceTransition(
  sql: SqlClient.SqlClient,
  input: { readonly operationId: string; readonly requestDigest: string },
  inspect: (step: Extract<ProjectWorkspaceNativeStep, { provider: "opencodeV2" }>) => Effect.Effect<
    {
      readonly nativeSessionId: string;
      readonly storageIdentity: string;
      readonly directory: string;
      readonly identity: unknown;
    },
    Error
  >,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      phase: string;
      stepsJson: string;
      resultSequence: number | null;
    }>`SELECT native.phase, native.steps_json AS "stepsJson", native.result_sequence AS "resultSequence"
      FROM project_workspace_native_operations native JOIN worktree_operations operation USING(operation_id)
      WHERE native.operation_id = ${input.operationId} AND operation.request_digest = ${input.requestDigest}`;
    const row = rows[0];
    if (!row)
      return yield* failure(
        "Workspace recovery command identity is unavailable. No native operation was dispatched.",
      );
    if (row.phase === "committed")
      return { status: "committed" as const, sequence: row.resultSequence };
    if (row.phase === "rejected") return { status: "rejected" as const };
    const decoded = yield* Effect.try({
      try: () => {
        const steps = decodeSteps(JSON.parse(row.stepsJson));
        const owners = new Set<string>();
        for (const step of steps) {
          const owner = JSON.stringify([step.threadId, step.provider, step.nativeSessionId]);
          if (owners.has(owner)) throw new Error("Duplicate native recovery owner");
          owners.add(owner);
        }
        return steps;
      },
      catch: () =>
        failure(
          "Workspace recovery journal is invalid. The project remains fenced; no native operation was dispatched.",
        ),
    }).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'recovery-required',
        error = ${decoded.failure.detail}, updated_at = ${new Date().toISOString()}
        WHERE operation_id = ${input.operationId} AND steps_json = ${row.stepsJson}
          AND phase NOT IN ('committed','rejected')`;
      return yield* decoded.failure;
    }
    // File staging has not been confirmed, so even a vacuously empty native manifest is not ready.
    if (row.phase === "prepared") return { status: "needs-resume" as const };
    const steps: ProjectWorkspaceNativeStep[] = [];
    let error: string | null = null;
    for (const step of decoded.success) {
      if (step.provider === "muse" || step.phase === "prepared") {
        steps.push(step);
        continue;
      }
      if (step.expectedIdentity === undefined) {
        error = `Native recovery identity is missing for thread '${step.threadId}'. Nothing was retried.`;
        steps.push(step);
        continue;
      }
      const observation = yield* inspect(step).pipe(Effect.result);
      if (observation._tag === "Failure") {
        error = `Native Location could not be confirmed for thread '${step.threadId}'. Nothing was retried; recovery remains required.`;
        steps.push(step);
        continue;
      }
      const current = observation.success;
      if (
        current.nativeSessionId !== step.nativeSessionId ||
        current.storageIdentity !== step.storageIdentity ||
        !isDeepStrictEqual(current.identity, step.expectedIdentity)
      ) {
        error = `Native ownership changed for thread '${step.threadId}'. Nothing was retried; recovery remains required.`;
        steps.push(step);
      } else if (current.directory === step.destinationDirectory) {
        steps.push({ ...step, phase: "verified" });
      } else {
        error =
          current.directory === step.sourceDirectory
            ? `Thread '${step.threadId}' remains at the original native Location. No uncertain move was resent. Inspect its transition before explicitly resuming.`
            : `Thread '${step.threadId}' has an unrecorded native Location. Nothing was retried; recovery remains required.`;
        steps.push(step);
      }
    }
    const complete =
      !error && steps.every((step) => step.provider === "muse" || step.phase === "verified");
    const phase = complete ? "native-verified" : "recovery-required";
    const updated = yield* sql`UPDATE project_workspace_native_operations
      SET steps_json = ${JSON.stringify(steps)}, phase = ${phase}, error = ${error}, updated_at = ${new Date().toISOString()}
      WHERE operation_id = ${input.operationId} AND phase = ${row.phase} AND steps_json = ${row.stepsJson}
      RETURNING operation_id`;
    if (updated.length !== 1)
      return yield* failure(
        "Workspace recovery state changed during inspection. Refresh its durable status; nothing was retried.",
      );
    return {
      status: complete ? ("ready-to-finalize" as const) : ("recovery-required" as const),
      error,
    };
  });
}
