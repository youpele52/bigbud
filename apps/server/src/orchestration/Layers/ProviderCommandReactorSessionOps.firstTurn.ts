import {
  type ChatAttachment,
  type ModelSelection,
  TextGenerationError,
  ThreadId,
} from "@bigbud/contracts";
import { Cause, Effect } from "effect";

import {
  buildGeneratedWorktreeBranchName,
  canReplaceThreadTitle,
  isTemporaryWorktreeBranch,
  serverCommandId,
  shouldRetryGeneratedThreadTitle,
} from "./ProviderCommandReactorHelpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.ts";

export const maybeGenerateAndRenameWorktreeBranchForFirstTurn = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateAndRenameWorktreeBranchForFirstTurn")(function* (input: {
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
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* gitStatusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

export const maybeGenerateThreadTitleForFirstTurn = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateThreadTitleForFirstTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection: ModelSelection;
    readonly titleSeed?: string;
  }) {
    const { textGeneration, orchestrationEngine, resolveThread } = services;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated = yield* Effect.suspend(() =>
        textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection: input.modelSelection,
        }),
      ).pipe(
        Effect.flatMap((result) =>
          shouldRetryGeneratedThreadTitle({
            generatedTitle: result.title,
            ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
          })
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "Generated thread title was too weak to replace the fallback.",
                }),
              )
            : Effect.succeed(result),
        ),
        Effect.retry({ times: 3 }),
      );
      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-rename"),
        threadId: input.threadId,
        title: generated.title,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename thread title", {
          threadId: input.threadId,
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });
