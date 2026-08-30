import {
  CommandId,
  type OrchestrationProject,
  type OrchestrationThread,
  ProjectId,
} from "@bigbud/contracts";
import { Duration, Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import { discoverProjectDeletionFiles } from "../../deletion/Layers/ProjectDeletion.files.ts";
import { ServerConfig } from "../../startup/config.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { waitForReadModelCondition, type ReadModelSettleCheck } from "./readModelSettle.ts";
import { DirectResourceCleanupExecutor } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";
import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import { calculateCommandPayloadDigest, commandPayloadDigestMatches } from "../commandDigest.ts";
import { executeReadyDirectCleanupPlan } from "../../deletion/Layers/DirectResourceCleanupCoordinator.ts";
import { makeDirectResourceCleanupExecutor } from "../../deletion/Layers/DirectResourceCleanupExecutor.ts";
import { makeDirectResourceCleanupRepository } from "../../persistence/Layers/DirectResourceCleanupRepository.ts";
import { directCleanupProofDigest } from "../../deletion/Layers/DirectResourceCleanup.proof.ts";
import {
  hydrateStoredDirectCleanupResources,
  readFinalizeReceiptStatus,
} from "./ProviderCommandReactorHandlers.delete.cleanup.ts";

type ProjectDeletionRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "project.deletion-requested" }
>;

interface ProjectDeletionDeps {
  readonly resolveProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProject | undefined>;
  readonly resolveThreadsByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThread>>;
}

const PROJECT_DELETE_TIMEOUT = Duration.seconds(30);

type ProjectThreadSettleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

function isActiveInDeletingSubtree(
  thread: OrchestrationThread,
  threadsById: ReadonlyMap<OrchestrationThread["id"], OrchestrationThread>,
): boolean {
  let current: OrchestrationThread | undefined = thread;
  const seen = new Set<OrchestrationThread["id"]>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.deletedAt !== null) return false;
    if (current.deletingAt != null) return true;
    const parentId: OrchestrationThread["id"] | undefined = current.parentThread?.threadId;
    current = parentId ? threadsById.get(parentId) : undefined;
  }
  return false;
}

export function evaluateProjectThreadSettle(
  threads: ReadonlyArray<OrchestrationThread>,
  projectId: ProjectId,
): ReadModelSettleCheck<ProjectThreadSettleResult> {
  const activeThreads = threads.filter((thread) => thread.deletedAt === null);
  if (activeThreads.length === 0) {
    return { done: true, value: { ok: true } };
  }
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const stranded = activeThreads.find((thread) => !isActiveInDeletingSubtree(thread, threadsById));
  if (stranded) {
    return {
      done: true,
      value: {
        ok: false,
        detail: `Thread '${stranded.id}' deletion failed while deleting project '${projectId}'.`,
      },
    };
  }
  return { done: false };
}

export const makeProcessProjectDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const cleanupExecutorService = yield* Effect.serviceOption(DirectResourceCleanupExecutor);
  const cleanupExecutor = Option.isSome(cleanupExecutorService)
    ? cleanupExecutorService.value
    : makeDirectResourceCleanupExecutor();
  const cleanupRepositoryService = yield* Effect.serviceOption(DirectResourceCleanupRepository);
  const cleanupRepository = Option.isSome(cleanupRepositoryService)
    ? cleanupRepositoryService.value
    : yield* makeDirectResourceCleanupRepository;
  const waitForProjectThreadsToSettle = Effect.fn("waitForProjectThreadsToSettle")(function* (
    deps: ProjectDeletionDeps,
    projectId: ProjectId,
  ): Effect.fn.Return<ProjectThreadSettleResult> {
    const evaluate = deps
      .resolveThreadsByProject(projectId)
      .pipe(Effect.map((threads) => evaluateProjectThreadSettle(threads, projectId)));
    return yield* waitForReadModelCondition({
      check: evaluate,
      events: orchestrationEngine.streamDomainEvents,
      timeout: PROJECT_DELETE_TIMEOUT,
      onTimeout: {
        ok: false as const,
        detail: `Timed out waiting for threads in project '${projectId}' to delete.`,
      },
    });
  });

  return Effect.fn("processProjectDeletionRequested")(function* (
    deps: ProjectDeletionDeps,
    event: ProjectDeletionRequestedEvent,
  ): Effect.fn.Return<void, OrchestrationDispatchError> {
    const project = yield* deps.resolveProject(event.payload.projectId);
    if (!project || project.deletedAt !== null) {
      return;
    }

    const result = yield* waitForProjectThreadsToSettle(deps, event.payload.projectId);
    const createdAt = new Date().toISOString();
    const abortDeletion = orchestrationEngine
      .dispatch({
        type: "project.delete.abort",
        commandId: serverCommandId("project-delete-abort"),
        projectId: event.payload.projectId,
        createdAt,
      })
      .pipe(
        Effect.ensuring(
          cleanupRepository
            .cancelIntentIfUnplanned(`deletion-intent:${event.eventId}`, createdAt)
            .pipe(Effect.ignore),
        ),
      );

    if (!result.ok) {
      yield* Effect.logWarning("project deletion aborted", {
        projectId: event.payload.projectId,
        detail: result.detail,
      });
      yield* abortDeletion;
      return;
    }

    const preparedExecutorExit = yield* Effect.exit(cleanupExecutor.prepare());
    if (preparedExecutorExit._tag === "Failure") {
      yield* abortDeletion;
      return;
    }
    const preparedExecutor = preparedExecutorExit.value;
    yield* Effect.gen(function* () {
      const files = yield* discoverProjectDeletionFiles(event.payload.projectId).pipe(
        Effect.provideService(ServerConfig, config),
        Effect.catch(() =>
          Effect.logWarning("project deletion resource capture failed", {
            projectId: event.payload.projectId,
            code: "identity_capture_failure",
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (files === undefined) {
        preparedExecutor.close();
        yield* abortDeletion;
        return;
      }
      const executorAlive = yield* Effect.exit(
        Effect.tryPromise(() => preparedExecutor.assertAlive()),
      );
      if (executorAlive._tag === "Failure") {
        yield* abortDeletion;
        return;
      }

      const finalizeCommandId = CommandId.makeUnsafe(
        `server:project-delete-finalize:${event.eventId}`,
      );
      const proposedFinalizeCommand = {
        type: "project.delete.finalize",
        commandId: finalizeCommandId,
        projectId: event.payload.projectId,
        createdAt: event.occurredAt,
      } as const;
      const operationId = `direct-cleanup:${event.eventId}`;
      let storedPlan = yield* cleanupRepository.loadPlan(operationId);
      if (!storedPlan) {
        const payloadDigest = calculateCommandPayloadDigest(proposedFinalizeCommand);
        const discoveredPlanDigest = createHash("sha256")
          .update(
            JSON.stringify({
              operationId,
              finalizeCommand: proposedFinalizeCommand,
              resources: files.resources,
            }),
          )
          .digest("hex");
        const preparedPlan = yield* Effect.exit(
          cleanupRepository.prepare({
            operationId,
            intentId: `deletion-intent:${event.eventId}`,
            finalizeCommandId,
            finalizePayloadJson: JSON.stringify(proposedFinalizeCommand),
            finalizePayloadDigestVersion: payloadDigest.version,
            finalizePayloadDigest: payloadDigest.digest,
            planDigest: discoveredPlanDigest,
            expectedPlatform: `${process.platform}/${process.arch}`,
            resources: files.resources,
            createdAt: event.occurredAt,
          }),
        );
        if (preparedPlan._tag === "Failure") {
          preparedExecutor.close();
          yield* abortDeletion;
          return;
        }
        storedPlan = yield* cleanupRepository.loadPlan(operationId);
      }
      if (!storedPlan) {
        yield* cleanupRepository.block(operationId, "plan_missing", new Date().toISOString());
        return;
      }
      const finalizeCommand = JSON.parse(
        storedPlan.finalizePayloadJson,
      ) as typeof proposedFinalizeCommand;
      if (
        finalizeCommand.type !== proposedFinalizeCommand.type ||
        finalizeCommand.commandId !== proposedFinalizeCommand.commandId ||
        finalizeCommand.projectId !== proposedFinalizeCommand.projectId ||
        !commandPayloadDigestMatches(finalizeCommand, {
          version: storedPlan.finalizePayloadDigestVersion,
          digest: storedPlan.finalizePayloadDigest,
        })
      ) {
        yield* cleanupRepository.block(
          operationId,
          "invalid_finalize_payload",
          new Date().toISOString(),
        );
        return;
      }
      const payloadDigest = {
        version: storedPlan.finalizePayloadDigestVersion,
        digest: storedPlan.finalizePayloadDigest,
      };
      const directResources = hydrateStoredDirectCleanupResources(config, storedPlan.resources);
      const dispatched = yield* Effect.exit(orchestrationEngine.dispatch(finalizeCommand));
      if (dispatched._tag === "Failure") {
        const receipt = yield* readFinalizeReceiptStatus(sql, finalizeCommandId).pipe(
          Effect.catch(() => Effect.succeed([])),
        );
        if (receipt[0]?.status === "rejected") {
          yield* cleanupRepository
            .cancelPrepared(operationId, new Date().toISOString())
            .pipe(Effect.ignore);
          yield* abortDeletion;
        } else {
          yield* Effect.logWarning("project deletion finalize outcome deferred", {
            projectId: event.payload.projectId,
          });
        }
        return;
      }
      const events = yield* orchestrationEngine.readEventsByCommandId!(finalizeCommandId);
      const deletionEvent = events.find((candidate) => candidate.type === "project.deleted");
      if (!deletionEvent) {
        preparedExecutor.close();
        yield* cleanupRepository
          .block(operationId, "finalize_proof_missing", new Date().toISOString())
          .pipe(Effect.catch(() => Effect.void));
        return;
      }
      const proofPersisted = yield* cleanupRepository
        .markFinalizeCommitted({
          operationId,
          aggregateKind: "project",
          aggregateId: event.payload.projectId,
          payloadDigestVersion: payloadDigest.version,
          payloadDigest: payloadDigest.digest,
          eventId: deletionEvent.eventId,
          eventSequence: deletionEvent.sequence,
          eventType: deletionEvent.type,
          eventPayloadJson: JSON.stringify(deletionEvent.payload),
          provenAt: new Date().toISOString(),
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("project cleanup finalize proof deferred", {
              projectId: event.payload.projectId,
              detail: String(error),
            }).pipe(Effect.as(false)),
          ),
        );
      if (proofPersisted) {
        yield* executeReadyDirectCleanupPlan({
          operationId,
          planDigest: storedPlan.planDigest,
          proofDigest: directCleanupProofDigest({
            operationId,
            payloadDigestVersion: payloadDigest.version,
            payloadDigest: payloadDigest.digest,
            eventId: deletionEvent.eventId,
            eventSequence: deletionEvent.sequence,
            eventType: deletionEvent.type,
            eventPayloadJson: JSON.stringify(deletionEvent.payload),
          }),
          resources: directResources,
          executor: preparedExecutor,
          repository: cleanupRepository,
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning("project resource cleanup deferred", {
              projectId: event.payload.projectId,
              code: "execution_failure",
            }),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("project deletion cleanup workflow deferred", {
          projectId: event.payload.projectId,
          detail: String(error),
        }),
      ),
      Effect.ensuring(
        Effect.tryPromise(() => preparedExecutor.shutdown()).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => preparedExecutor.close())),
        ),
      ),
    );
  });
});
