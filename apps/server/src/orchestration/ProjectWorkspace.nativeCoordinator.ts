import { isLocalExecutionTargetId, type OrchestrationCommand } from "@bigbud/contracts";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { calculateCommandPayloadDigest } from "./commandDigest.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { inventoryProjectWorkspaceNative } from "./ProjectWorkspace.nativeInventory.ts";
import { reserveProjectWorkspaceTransition } from "./ProjectWorkspace.nativeReservation.ts";
import {
  reconcileProjectWorkspaceTransition,
  type ProjectWorkspaceNativeStep,
} from "./ProjectWorkspace.nativeRecovery.ts";
import { prepareIdleProjectWorkspaceSessions } from "./ProjectWorkspace.nativeSessions.ts";
import { stageLocalProjectWorkspace } from "./ProjectWorkspace.files.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { recordWorkspacePreflightRefusal } from "./ProjectWorkspace.preflightReceipt.ts";

type V2Step = Extract<ProjectWorkspaceNativeStep, { provider: "opencodeV2" }>;
export interface QualifiedWorkspaceNativeAccess {
  /** Installed only by a qualified native owner; never constructed from client flags or environment opt-outs. */
  readonly move: (
    step: V2Step,
    beforeDispatch: (identity: Schema.Json) => Effect.Effect<void, Error>,
  ) => Effect.Effect<void, Error>;
  readonly inspect: (
    step: V2Step,
  ) => Effect.Effect<
    { nativeSessionId: string; storageIdentity: string; directory: string; identity: unknown },
    Error
  >;
}

/** Production orchestration boundary. Absence of147 or qualified V2 access preserves native refusal.
 * Tests may inject controlled native access; no SDK ownership hacks or replay callbacks exist here.
 */
export function makeProjectWorkspaceNativeCoordinator(input: {
  readonly sql: SqlClient.SqlClient;
  readonly engine: OrchestrationEngineShape;
  readonly registry: ProviderAdapterRegistryShape;
  readonly v2?: QualifiedWorkspaceNativeAccess;
  readonly receipts?: OrchestrationCommandReceiptRepositoryShape;
}) {
  const { sql, engine, registry, v2 } = input;
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: "project.reconfigure", detail });
  const inspect: QualifiedWorkspaceNativeAccess["inspect"] =
    v2?.inspect ??
    (() =>
      Effect.fail(
        new Error(
          "Qualified V2 native Location inspection is unavailable. No native mutation was attempted.",
        ),
      ));
  return (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (
        command.type !== "project.reconfigure" ||
        !command.workspaceRoot ||
        !isLocalExecutionTargetId(command.workspaceExecutionTargetId)
      )
        return yield* engine.dispatch(command);
      // Receipt replay/conflict must precede filesystem or native side effects. The engine owns
      // canonical digest validation and terminal-result replay, including prior preflight refusals.
      if (input.receipts) {
        const receipt = yield* input.receipts.getByCommandId({ commandId: command.commandId });
        if (Option.isSome(receipt)) return yield* engine.dispatch(command);
      }
      const initialModel = yield* engine.getReadModel();
      const project = initialModel.projects.find((p) => p.id === command.projectId);
      if (
        !project?.workspaceRoot ||
        project.workspaceRoot === command.workspaceRoot ||
        !isLocalExecutionTargetId(project.workspaceExecutionTargetId ?? project.executionTargetId)
      )
        return yield* engine.dispatch(command);
      const schema =
        yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_native_operations'`;
      if (!schema.length) return yield* engine.dispatch(command);
      const digest = calculateCommandPayloadDigest(command).digest;
      const operationId = `project-workspace-native:${command.commandId}`;
      const retained = yield* sql<{
        phase: string;
        requestDigest: string;
        requestJson: string;
      }>`SELECT native.phase,
      operation.request_digest AS "requestDigest", native.request_json AS "requestJson"
      FROM project_workspace_native_operations native JOIN worktree_operations operation USING(operation_id)
      WHERE native.command_id = ${command.commandId}`;
      if (retained.length) {
        const row = retained[0]!;
        if (row.requestDigest !== digest || row.requestJson !== JSON.stringify(command))
          return yield* fail(
            "Retained native workspace command identity differs. No files or native operations were retried.",
          );
        if (row.phase === "committed") return yield* engine.dispatch(command);
        const result = yield* reconcileProjectWorkspaceTransition(
          sql,
          { operationId, requestDigest: digest },
          inspect,
        );
        if (result.status !== "ready-to-finalize")
          return yield* fail(
            `Workspace operation '${operationId}' still requires explicit recovery. No transfer or uncertain native move was resent. Originals remain at '${project.workspaceRoot}'; inspect '${command.workspaceRoot}' before recovery.`,
          );
        return yield* engine.dispatch(command, { nativeWorkspaceOperationId: operationId });
      }
      const inventory = yield* inventoryProjectWorkspaceNative(
        sql,
        command.projectId,
        project.workspaceRoot,
        command.workspaceRoot,
      );
      if (!inventory.owners.length) return yield* engine.dispatch(command);
      if (
        inventory.owners.some((owner) => owner.provider === "muse") &&
        command.nativeContextReset !== "archive-and-reset-muse"
      )
        return yield* fail(
          "Explicit Muse native-context reset confirmation is required. Visible bigbud history stays; original native context is archived for recovery, and a fresh Muse session starts only on next explicit use with the selected provider/model.",
        );
      if (inventory.owners.some((owner) => owner.provider === "opencodeV2") && !v2)
        return yield* fail(
          "V2 native workspace relocation is not qualified in this environment. Keep this project folder until supported native context preservation is qualified; no files or sessions were changed.",
        );
      if (!engine.withWorkspaceBarrier)
        return yield* fail(
          "The workspace admission barrier is unavailable. No files or sessions were changed.",
        );
      if (project.updatedAt !== command.expectedUpdatedAt)
        return yield* fail(
          "Project changed since this edit opened. Refresh before changing folders.",
        );
      const worktrees =
        yield* sql`SELECT 1 FROM projection_threads WHERE project_id = ${command.projectId} AND worktree_path IS NOT NULL LIMIT 1`;
      if (worktrees.length)
        return yield* fail(
          "Detach or remove all historical project worktrees before changing folders. Nothing was transferred.",
        );
      const sessions = yield* prepareIdleProjectWorkspaceSessions(
        sql,
        registry,
        engine,
        command.projectId,
      );
      yield* engine.withWorkspaceBarrier(
        sql.withTransaction(
          Effect.gen(function* () {
            const current = (yield* engine.getReadModel()).projects.find(
              (p) => p.id === command.projectId,
            );
            if (
              current?.updatedAt !== command.expectedUpdatedAt ||
              current.workspaceRoot !== project.workspaceRoot
            )
              return yield* fail(
                "Project changed while idle sessions were closing. Refresh before retrying.",
              );
            yield* decideOrchestrationCommand({ command, readModel: yield* engine.getReadModel() });
            const live = yield* inventoryProjectWorkspaceNative(
              sql,
              command.projectId,
              project.workspaceRoot!,
              command.workspaceRoot!,
            );
            if (JSON.stringify(live.owners) !== JSON.stringify(inventory.owners))
              return yield* fail(
                "Native ownership changed while sessions were closing. Refresh before retrying; nothing was transferred.",
              );
            const reserved = yield* reserveProjectWorkspaceTransition(sql, {
              operationId,
              commandId: command.commandId,
              projectId: command.projectId,
              requestDigest: digest,
              requestJson: JSON.stringify(command),
              sourcePath: project.workspaceRoot!,
              destinationPath: command.workspaceRoot!,
              idleOwners: sessions.idleOwners,
            });
            if (reserved.retained)
              return yield* fail(
                "Workspace operation already exists. Inspect its status; no work was redispatched.",
              );
            yield* sql`UPDATE project_workspace_native_operations SET steps_json = ${JSON.stringify(live.steps)} WHERE operation_id = ${operationId}`;
          }),
        ),
      );
      const transition = yield* Effect.gen(function* () {
        yield* sessions.stop;
        yield* Effect.tryPromise({
          try: () => stageLocalProjectWorkspace(command, project),
          catch: (cause) => fail(String(cause)),
        });
        yield* sql`UPDATE project_workspace_native_operations SET phase = 'files-ready', updated_at = ${new Date().toISOString()} WHERE operation_id = ${operationId} AND phase = 'prepared'`;
        const steps = [...inventory.steps];
        for (const [index, step] of steps.entries()) {
          if (step.provider !== "opencodeV2") continue;
          if (!v2)
            return yield* fail(
              "Qualified native workspace relocation is unavailable. The project remains fenced.",
            );
          yield* v2.move(step, (identity) =>
            Effect.gen(function* () {
              steps[index] = { ...step, phase: "dispatched", expectedIdentity: identity };
              const changed =
                yield* sql`UPDATE project_workspace_native_operations SET phase = 'native-dispatched',
            steps_json = ${JSON.stringify(steps)}, updated_at = ${new Date().toISOString()}
            WHERE operation_id = ${operationId} AND phase IN ('files-ready','native-dispatched') RETURNING operation_id`;
              if (changed.length !== 1)
                return yield* fail(
                  "Native dispatch intent could not be durably confirmed. Nothing was sent.",
                );
            }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
          );
        }
        const verified = yield* reconcileProjectWorkspaceTransition(
          sql,
          { operationId, requestDigest: digest },
          inspect,
        );
        if (verified.status !== "ready-to-finalize")
          return yield* fail(
            `Workspace operation '${operationId}' requires native recovery. No uncertain move was resent.`,
          );
        return yield* engine.dispatch(command, { nativeWorkspaceOperationId: operationId });
      }).pipe(Effect.result);
      if (transition._tag === "Failure") {
        yield* sql`UPDATE project_workspace_native_operations SET phase = 'recovery-required', error = ${String(transition.failure)},
        updated_at = ${new Date().toISOString()} WHERE operation_id = ${operationId} AND phase NOT IN ('committed','rejected')`.pipe(
          Effect.result,
        );
        return yield* fail(
          `Workspace operation '${operationId}' is retained for recovery. Originals remain at '${project.workspaceRoot}'; destination '${command.workspaceRoot}' may contain copied files. No folders were deleted. ${String(transition.failure)}`,
        );
      }
      return transition.success;
    }).pipe(
      Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
        recordWorkspacePreflightRefusal({
          sql,
          engine,
          command,
          error,
          ...(input.receipts ? { receipts: input.receipts } : {}),
        }),
      ),
    );
}
