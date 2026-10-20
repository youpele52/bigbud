import { type ChatAttachment, ThreadId } from "@bigbud/contracts";
import { Cause, Effect, Option } from "effect";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  buildGeneratedWorktreeBranchName,
  isTemporaryWorktreeBranch,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import { assertSavedWorktreeIdentity } from "../../git/Layers/WorktreeSavedIdentity.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { lastSuccessfulThreadModel } from "../../git/Layers/InternalTextGeneration.success.ts";
import {
  recordThreadTextGenerationStatus,
  withThreadTextGenerationJob,
} from "../../git/Layers/InternalTextGeneration.status.ts";
import { uncertainTextGenerationError } from "../../git/Layers/InternalTextGeneration.uncertainty.ts";
import { makeTextGenerationDispatchClaim } from "../../git/Layers/InternalTextGeneration.dispatch.ts";

export const maybeGenerateAndRenameWorktreeBranchForFirstTurn = (services: SessionOpServices) => {
  const generate = Effect.fn("maybeGenerateAndRenameWorktreeBranchForFirstTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const {
      git,
      textGeneration,
      serverSettingsService,
      orchestrationEngine,
      gitStatusBroadcaster,
    } = services;
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: preference } = yield* serverSettingsService.getSettings;
      const thread = yield* services.resolveThread(input.threadId);
      if (
        !thread ||
        thread.archivedAt ||
        thread.deletingAt ||
        thread.deletedAt ||
        thread.branch !== oldBranch ||
        thread.worktreePath !== cwd
      )
        return;
      const workspaceExecutionTargetId = resolveWorkspaceExecutionTargetId(thread);
      if (hasTextGenerationUncertainty(thread.activities, "branch")) return;
      const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isSome(sql)) yield* assertSavedWorktreeIdentity(sql.value, input.threadId);
      let successfulModelSelection = lastSuccessfulThreadModel(thread);
      let modelSelection = preference ?? successfulModelSelection;
      if (!modelSelection) {
        yield* recordThreadTextGenerationStatus(
          orchestrationEngine,
          input.threadId,
          "branch",
          "deferred",
          { branch: oldBranch, worktreePath: cwd, workspaceExecutionTargetId },
        );
        // Publishing intent before rereading closes a success-before-deferral lost wakeup.
        // Later success handlers wait for this job and recheck its workspace guards.
        const fresh = yield* services.resolveThread(input.threadId);
        if (
          !fresh ||
          fresh.archivedAt ||
          fresh.deletingAt ||
          fresh.deletedAt ||
          fresh.branch !== oldBranch ||
          fresh.worktreePath !== cwd ||
          resolveWorkspaceExecutionTargetId(fresh) !== workspaceExecutionTargetId
        )
          return;
        successfulModelSelection = lastSuccessfulThreadModel(fresh);
        modelSelection = preference ?? successfulModelSelection;
        if (!modelSelection) return;
      }

      const claim = makeTextGenerationDispatchClaim(orchestrationEngine, input.threadId, "branch");
      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
        successfulModelSelection,
        beforeV2Dispatch: claim.beforeV2Dispatch,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) {
        yield* recordThreadTextGenerationStatus(
          orchestrationEngine,
          input.threadId,
          "branch",
          "unchanged",
        );
        return;
      }
      const current = yield* services.resolveThread(input.threadId);
      if (
        !current ||
        current.archivedAt ||
        current.deletingAt ||
        current.deletedAt ||
        current.branch !== oldBranch ||
        current.worktreePath !== cwd ||
        resolveWorkspaceExecutionTargetId(current) !== workspaceExecutionTargetId
      )
        return;

      if (Option.isSome(sql)) yield* assertSavedWorktreeIdentity(sql.value, input.threadId);
      const renamed = yield* git.renameBranch({
        cwd,
        oldBranch,
        newBranch: targetBranch,
        executionTargetId: workspaceExecutionTargetId,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      if (isLocalExecutionTarget(workspaceExecutionTargetId))
        yield* gitStatusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
      yield* recordThreadTextGenerationStatus(
        orchestrationEngine,
        input.threadId,
        "branch",
        "completed",
      );
    }).pipe(
      Effect.catchCause((cause) => {
        const uncertainty = uncertainTextGenerationError(cause);
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning(
          "provider command reactor failed to generate or rename worktree branch",
          {
            threadId: input.threadId,
            cwd,
            oldBranch,
            cause: Cause.pretty(cause),
          },
        ).pipe(
          Effect.andThen(
            recordThreadTextGenerationStatus(
              orchestrationEngine,
              input.threadId,
              "branch",
              uncertainty ? "uncertain" : "failed",
              uncertainty?.uncertaintyId ? { uncertaintyId: uncertainty.uncertaintyId } : undefined,
            ),
          ),
        );
      }),
    );
  });
  return (input: Parameters<typeof generate>[0]) =>
    withThreadTextGenerationJob(
      services.orchestrationEngine,
      input.threadId,
      "branch",
      generate(input),
      true,
    );
};

export { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";
