/**
 * `create_thread`: delegate a task to a new tributary thread. Every derived command uses the
 * delegation's `createdAt`, so a retried invocation dispatches identical commands (AC9). An
 * optional agent `modelSelection` is decided once and never fails the delegation (Goal 11).
 *
 * @module ThreadOrchestrationTools.createThread
 */
import { CommandId, MessageId, ProjectId, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type { ProjectionThreadWatchRepositoryShape } from "../persistence/Services/ProjectionThreadWatches.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import {
  decisionRecord,
  decisionThreadModel,
  modelChoiceResultFields,
  readStoredModelDecision,
  resolveDelegationModelDecision,
  startDelegatedFirstTurn,
} from "./ThreadOrchestrationTools.createThread.modelChoice.ts";
import { isAbsentModelSelection } from "./ThreadOrchestrationTools.modelChoice.ts";
import {
  buildInitialDelegationPrompt,
  delegationError,
  initialDelegationOrigin,
  notifyDelegationLinked,
  stableThreadToolId,
} from "./ThreadOrchestrationTools.origins.ts";

export const createThreadViaOrchestration = Effect.fn("createThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    readonly projectionThreadWatchRepository: ProjectionThreadWatchRepositoryShape;
    readonly callerThreadId: ThreadId;
    readonly sourceMessageId: MessageId;
    readonly invocationId: string;
    readonly title: string;
    readonly task: string;
    readonly projectId?: ProjectId;
    readonly watchForCompletion: boolean;
    /** Raw agent request (Goal 11); absent means today's behavior exactly. */
    readonly modelSelection?: unknown;
    readonly modelSources?: ThreadToolModelSources | null;
  }) {
    const title = input.title.trim();
    const task = input.task.trim();
    const invocationId = input.invocationId.trim();
    if (title.length === 0 || title.length > 200) {
      return yield* Effect.fail(new Error("Thread title must be between 1 and 200 characters."));
    }
    if (task.length === 0 || task.length > 32_000) {
      return yield* Effect.fail(new Error("Thread task must be between 1 and 32000 characters."));
    }
    if (invocationId.length === 0) {
      return yield* Effect.fail(new Error("Invocation ID is required."));
    }

    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread || callerThread.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread was not found."));
    }
    if (callerThread.deletingAt) {
      return yield* Effect.fail(new Error("Caller thread is being deleted."));
    }
    const targetProjectId = input.projectId ?? callerThread.projectId;
    const targetProject = readModel.projects.find((project) => project.id === targetProjectId);
    if (!targetProject || targetProject.deletedAt !== null) {
      return yield* Effect.fail(new Error(`Project '${targetProjectId}' was not found.`));
    }
    if (targetProject.deletingAt) {
      return yield* Effect.fail(new Error(`Project '${targetProjectId}' is being deleted.`));
    }

    const identity = `${input.callerThreadId}\n${input.sourceMessageId}\n${invocationId}`;
    const delegationId = stableThreadToolId("delegation", identity);
    const childThreadId = ThreadId.makeUnsafe(stableThreadToolId("thread", identity));
    const childTurnId = TurnId.makeUnsafe(stableThreadToolId("turn", identity));
    const now = new Date().toISOString();
    const existing = yield* input.threadDelegationRepository
      .getByInvocation({
        callerThreadId: input.callerThreadId,
        sourceMessageId: input.sourceMessageId,
        invocationId,
      })
      .pipe(Effect.mapError(delegationError));
    const delegation = Option.isSome(existing)
      ? existing.value
      : yield* input.threadDelegationRepository
          .reserve({
            delegationId,
            callerThreadId: input.callerThreadId,
            sourceMessageId: input.sourceMessageId,
            invocationId,
            parentDelegationId: null,
            rootDelegationId: delegationId,
            depth: 0,
            targetKind: "project",
            targetProjectId,
            targetCanonicalWorkspace: null,
            childThreadId,
            childTurnId,
            createdProjectId: null,
            createdAt: now,
            updatedAt: now,
          })
          .pipe(Effect.mapError(delegationError));
    // Retries must dispatch byte-identical commands; a fresh clock would conflict on replay.
    const createdAt = delegation.createdAt;

    const child = readModel.threads.find((thread) => thread.id === delegation.childThreadId);
    if (delegation.state === "completed" || delegation.state === "watch_armed") {
      const stored = readStoredModelDecision(delegation.resultJson);
      return {
        accepted: true,
        replayed: true,
        childThreadId: delegation.childThreadId,
        childTurnId: delegation.childTurnId,
        observedStatus: child ? resolveThreadWorkflowStatus(child) : null,
        ...(stored !== undefined ? modelChoiceResultFields(stored) : {}),
      } as const;
    }

    const parentThread = {
      threadId: callerThread.id,
      title: callerThread.title,
      projectId: callerThread.projectId,
    } as const;
    const provenance = buildInitialDelegationPrompt({
      parent: {
        id: callerThread.id,
        title: callerThread.title,
        projectId: callerThread.projectId,
      },
      delegationId: delegation.delegationId,
      task,
    });

    const updateState = (
      state: Parameters<ThreadDelegationRepositoryShape["updateState"]>[0]["state"],
    ) =>
      input.threadDelegationRepository
        .updateState({
          delegationId: delegation.delegationId,
          state,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(delegationError));

    const callerExecutionTargets =
      targetProjectId === callerThread.projectId
        ? {
            providerRuntimeExecutionTargetId: callerThread.providerRuntimeExecutionTargetId,
            workspaceExecutionTargetId: callerThread.workspaceExecutionTargetId,
            executionTargetId: callerThread.executionTargetId,
          }
        : {};
    const decision = isAbsentModelSelection(input.modelSelection)
      ? undefined
      : yield* resolveDelegationModelDecision({
          repository: input.threadDelegationRepository,
          delegation,
          identity,
          request: input.modelSelection,
          sources: input.modelSources,
          trunk: callerThread.modelSelection,
          target:
            targetProjectId === callerThread.projectId
              ? callerExecutionTargets
              : {
                  providerRuntimeExecutionTargetId: targetProject.providerRuntimeExecutionTargetId,
                  workspaceExecutionTargetId: targetProject.workspaceExecutionTargetId,
                },
        });

    yield* updateState("project_resolved");
    const createResult = yield* input.orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(stableThreadToolId("command", `${identity}:create`)),
        threadId: delegation.childThreadId,
        projectId: targetProjectId,
        title,
        purpose: "standard",
        ...callerExecutionTargets,
        modelSelection:
          decision === undefined ? callerThread.modelSelection : decisionThreadModel(decision),
        runtimeMode: callerThread.runtimeMode,
        interactionMode: callerThread.interactionMode,
        branch: null,
        worktreePath: null,
        parentThread,
        createdAt,
      })
      .pipe(Effect.mapError(delegationError));
    yield* updateState("thread_accepted");
    yield* notifyDelegationLinked(
      input,
      delegation,
      targetProjectId,
      title,
      createdAt,
      decision === undefined
        ? undefined
        : {
            requested: decisionRecord(decision).requested,
            status: decisionRecord(decision).status,
          },
    );
    const prompt = {
      messageId: input.sourceMessageId,
      text: provenance,
      originSegments: [initialDelegationOrigin({ parent: callerThread, task })],
    };
    const turnResult =
      decision === undefined
        ? yield* input.orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(stableThreadToolId("command", `${identity}:turn`)),
              threadId: delegation.childThreadId,
              message: { ...prompt, role: "user", attachments: [] },
              modelSelection: callerThread.modelSelection,
              runtimeMode: callerThread.runtimeMode,
              interactionMode: callerThread.interactionMode,
              createdAt,
            })
            .pipe(Effect.mapError(delegationError))
        : yield* startDelegatedFirstTurn({
            orchestrationEngine: input.orchestrationEngine,
            decision,
            identity,
            childThreadId: delegation.childThreadId,
            createdAt,
            callerThread,
            prompt,
          });
    const storedDecision = decision === undefined ? {} : { modelDecision: decision };
    if (input.watchForCompletion) {
      yield* input.projectionThreadWatchRepository
        .addActiveWatch({
          watcherThreadId: input.callerThreadId,
          watchedThreadId: delegation.childThreadId,
          watchedThreadTitle: title,
          sourceMessageId: input.sourceMessageId,
          createdAt,
        })
        .pipe(
          Effect.mapError(delegationError),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* input.threadDelegationRepository
                .storeResult({
                  delegationId: delegation.delegationId,
                  // Keep the decision so a retry reuses it rather than re-deciding.
                  resultJson: decision === undefined ? null : JSON.stringify(storedDecision),
                  errorJson: JSON.stringify({ message: error.message }),
                  updatedAt: new Date().toISOString(),
                })
                .pipe(Effect.mapError(delegationError));
              yield* updateState("failed");
              return yield* Effect.fail(error);
            }),
          ),
        );
      yield* updateState("watch_armed");
    } else {
      yield* updateState("turn_accepted");
    }
    const result = {
      accepted: true,
      replayed: false,
      childThreadId: delegation.childThreadId,
      childTurnId: delegation.childTurnId,
      createSequence: createResult.sequence,
      turnSequence: turnResult.sequence,
      watchForCompletion: input.watchForCompletion,
    } as const;
    yield* input.threadDelegationRepository
      .storeResult({
        delegationId: delegation.delegationId,
        resultJson: JSON.stringify({ ...result, ...storedDecision }),
        errorJson: null,
        updatedAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError(delegationError));
    yield* updateState("completed");
    const updatedReadModel = yield* input.orchestrationEngine.getReadModel();
    const updatedChild = updatedReadModel.threads.find(
      (thread) => thread.id === delegation.childThreadId,
    );
    return {
      ...result,
      observedStatus: updatedChild ? resolveThreadWorkflowStatus(updatedChild) : null,
      ...(decision !== undefined ? modelChoiceResultFields(decision) : {}),
    } as const;
  },
);
