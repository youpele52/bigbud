import {
  BUILT_IN_CHATS_PROJECT_ID,
  type OrchestrationReadModel,
  ThreadId,
} from "@bigbud/contracts";
import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionOperationalStateQueryLive } from "./ProjectionOperationalStateQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";
import { makeProjectionPipelinePrefixedTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const layer = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionOperationalStateQueryLive,
  ProjectionCatalogQueryLive,
).pipe(Layer.provideMerge(makeProjectionPipelinePrefixedTestLayer("retained-family-snapshot-")));

/** Real event projector -> SQLite repository -> production reconnect queries.
 * Also consumed by the browser-model regression; no manufactured hydration flag. */
export function readRetainedFamilySqlSnapshots(): Promise<
  ReadonlyArray<{
    expected: boolean;
    snapshot: OrchestrationReadModel;
    mobile: OrchestrationReadModel;
    mobileSelected: boolean | undefined;
    operational: OrchestrationReadModel;
    threadOperational: OrchestrationReadModel;
    history: OrchestrationReadModel;
    /** The bounded web startup reads: sidebar catalog and the project's thread page. */
    sidebarSummary: ThreadSummary | undefined;
    projectSummary: ThreadSummary | undefined;
    stored: boolean | undefined;
    raw: number | undefined;
  }>
> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const events = yield* OrchestrationEventStore;
        const query = yield* ProjectionSnapshotQuery;
        const operational = yield* ProjectionOperationalStateQuery;
        const catalog = yield* ProjectionCatalogQuery;
        const sessions = yield* ProjectionThreadSessionRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("retained-family-sql");
        const now = "2026-10-21T00:00:00.000Z";
        yield* events.append(
          makeEvent({
            sequence: 1,
            type: "project.created",
            aggregateKind: "project",
            aggregateId: "family-project",
            occurredAt: now,
            commandId: "family-project",
            payload: {
              projectId: "family-project",
              title: "Family",
              workspaceRoot: "/scripted/family",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        yield* events.append(
          makeEvent({
            sequence: 2,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: "family-thread",
            payload: {
              threadId,
              projectId: "family-project",
              title: "Family",
              modelSelection: { provider: "opencodeV2", model: "scripted" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        // Pinned so the thread is also in the sidebar catalog (its recents cover only Chats).
        // The sidebar's recents cover only the built-in Chats project, so a Chats thread mirrors
        // every session update for the sidebar read; the project page reads the thread above.
        const chatThreadId = ThreadId.makeUnsafe("retained-family-chat");
        yield* events.append(
          makeEvent({
            sequence: 3,
            type: "project.created",
            aggregateKind: "project",
            aggregateId: BUILT_IN_CHATS_PROJECT_ID,
            occurredAt: now,
            commandId: "family-chats-project",
            payload: {
              projectId: BUILT_IN_CHATS_PROJECT_ID,
              title: "Chats",
              workspaceRoot: "/scripted/chats",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        yield* events.append(
          makeEvent({
            sequence: 4,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: chatThreadId,
            occurredAt: now,
            commandId: "family-chat-thread",
            payload: {
              threadId: chatThreadId,
              projectId: BUILT_IN_CHATS_PROJECT_ID,
              title: "Family chat",
              modelSelection: { provider: "opencodeV2", model: "scripted" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        yield* pipeline.bootstrap;
        const results = [];
        let sequence = 4;
        for (const retainedFamily of [undefined, true, false, true, undefined]) {
          for (const target of [threadId, chatThreadId]) {
            sequence++;
            const event = yield* events.append(
              makeEvent({
                sequence,
                type: "thread.session-set",
                aggregateKind: "thread",
                aggregateId: target,
                occurredAt: now,
                commandId: `family-session-${sequence}`,
                payload: {
                  threadId: target,
                  session: {
                    threadId: target,
                    status: "ready",
                    providerName: "opencodeV2",
                    runtimeMode: "full-access",
                    activeTurnId: null,
                    sessionEpoch: 1,
                    reason: null,
                    lastError: null,
                    updatedAt: now,
                    ...(retainedFamily === undefined ? {} : { retainedFamily }),
                  },
                },
              }),
            );
            yield* pipeline.projectEvent(event);
          }
          const snapshot = yield* query.getSnapshot();
          const mobile = yield* query.getMobileRecoveryBaseline!(threadId);
          const startup = yield* operational.getStartupOperationalState();
          const thread = Option.getOrThrow(yield* operational.getThreadOperationalState(threadId));
          const history = Option.getOrThrow(yield* operational.getFullThreadHistory(threadId));
          const sidebar = yield* catalog.getSidebarThreadCatalog();
          const projectPage = yield* catalog.getProjectThreadSummaries({
            projectId: "family-project" as ThreadSummary["projectId"],
          });
          const stored = Option.getOrThrow(yield* sessions.getByThreadId({ threadId }));
          const raw = yield* sql<{
            retained: number;
          }>`SELECT retained_family AS retained FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
          results.push({
            expected: retainedFamily ?? false,
            snapshot,
            mobile: mobile.snapshot,
            mobileSelected:
              mobile.selectedThread?.status === "present"
                ? mobile.selectedThread.thread.session?.retainedFamily
                : undefined,
            operational: startup,
            threadOperational: thread,
            history,
            sidebarSummary: sidebar.threads.find((summary) => summary.id === chatThreadId),
            projectSummary: projectPage.threads.find((summary) => summary.id === threadId),
            stored: stored.retainedFamily,
            raw: raw[0]?.retained,
          });
        }
        return results;
      }).pipe(Effect.provide(layer)),
    ),
  );
}
