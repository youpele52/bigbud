import {
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  ListCatalogThreadsInput,
  ProjectionCatalogQueryShape,
} from "../orchestration/Services/ProjectionCatalogQuery.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import {
  LIST_THREADS_MAX_LIMIT,
  listThreadsViaOrchestration,
  normalizeListThreadsLimit,
} from "./ThreadOrchestrationTools.listThreads.ts";

const CALLER_THREAD_ID = ThreadId.makeUnsafe("thread-list-caller");
const PROJECT_ID = ProjectId.makeUnsafe("project-list-primary");
const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-list-other");
const NOW = "2026-07-26T00:00:00.000Z";

function makeProject(id: ProjectId, title: string): OrchestrationProject {
  return {
    id,
    title,
    workspaceRoot: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletingAt: null,
    deletedAt: null,
  };
}

function assistantMessage(text: string): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(`message-${text}`),
    role: "assistant",
    text,
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(input: {
  readonly id: string;
  readonly projectId?: ProjectId;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly deletingAt?: string | null;
  readonly deletedAt?: string | null;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
}): OrchestrationThread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? PROJECT_ID,
    title: input.title ?? input.id,
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: input.updatedAt ?? NOW,
    archivedAt: input.archivedAt ?? null,
    deletingAt: input.deletingAt ?? null,
    pinnedAt: null,
    deletedAt: input.deletedAt ?? null,
    messages: input.messages ?? [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  };
}

function makeHarness(threads: ReadonlyArray<OrchestrationThread>) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    projects: [
      makeProject(PROJECT_ID, "Primary project"),
      makeProject(OTHER_PROJECT_ID, "Other project"),
    ],
    threads: [makeThread({ id: CALLER_THREAD_ID, title: "Caller thread" }), ...threads],
    updatedAt: NOW,
  };
  const projectionCatalogQuery = {
    listThreads: (input: ListCatalogThreadsInput) => {
      const caller = readModel.threads.find((thread) => thread.id === input.callerThreadId);
      if (!caller || caller.deletedAt) {
        return Effect.succeed({
          callerResolved: false,
          projectId: null,
          projectTitle: null,
          totalCount: 0,
          threads: [],
        });
      }
      const projectId = input.projectId ?? caller.projectId;
      const project = readModel.projects.find(
        (candidate) => candidate.id === projectId && !candidate.deletedAt,
      );
      if (!project) {
        return Effect.succeed({
          callerResolved: true,
          projectId: null,
          projectTitle: null,
          totalCount: 0,
          threads: [],
        });
      }
      const matching = readModel.threads
        .filter(
          (thread) =>
            thread.projectId === projectId &&
            !thread.deletedAt &&
            (input.status === "all" ||
              (input.status === "archived"
                ? thread.archivedAt
                : !thread.archivedAt && !thread.deletingAt)),
        )
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        );
      return Effect.succeed({
        callerResolved: true,
        projectId,
        projectTitle: project.title,
        totalCount: matching.length,
        threads: matching.slice(0, input.limit).map((thread) => {
          const status = resolveThreadWorkflowStatus(thread);
          const row = {
            threadId: thread.id,
            title: thread.title,
            workflowStatus: status.workflowStatus,
            isAgentActive: status.isAgentActive,
            isWorkflowComplete: status.isWorkflowComplete,
            archived: thread.archivedAt !== null,
            pinned: thread.pinnedAt !== null,
            deleting: Boolean(thread.deletingAt),
            purpose: thread.purpose ?? "standard",
            parentThreadId: thread.parentThread?.threadId ?? null,
            latestTurnState: status.latestTurnState,
            hasPendingApprovals: status.hasPendingApprovals,
            hasPendingUserInput: status.hasPendingUserInput,
            messageCount: thread.messages.length,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          };
          return input.includeExcerpt
            ? Object.assign(row, { lastAssistantExcerpt: status.lastAssistantExcerpt })
            : row;
        }),
      });
    },
  } as unknown as ProjectionCatalogQueryShape;
  return { projectionCatalogQuery };
}

describe("normalizeListThreadsLimit", () => {
  it("clamps to the supported range and defaults when unset", () => {
    expect(normalizeListThreadsLimit(undefined)).toBe(50);
    expect(normalizeListThreadsLimit(0)).toBe(1);
    expect(normalizeListThreadsLimit(-5)).toBe(1);
    expect(normalizeListThreadsLimit(10.7)).toBe(10);
    expect(normalizeListThreadsLimit(10_000)).toBe(LIST_THREADS_MAX_LIMIT);
    expect(normalizeListThreadsLimit(Number.NaN)).toBe(50);
  });
});

describe("listThreadsViaOrchestration", () => {
  it("returns active threads in the caller project, most recently updated first", async () => {
    const harness = makeHarness([
      makeThread({ id: "thread-old", updatedAt: "2026-07-20T00:00:00.000Z" }),
      makeThread({ id: "thread-new", updatedAt: "2026-07-25T00:00:00.000Z" }),
      makeThread({ id: "thread-archived", archivedAt: NOW }),
      makeThread({ id: "thread-deleted", deletedAt: NOW }),
      makeThread({ id: "thread-elsewhere", projectId: OTHER_PROJECT_ID }),
    ]);

    const result = await Effect.runPromise(
      listThreadsViaOrchestration({ ...harness, callerThreadId: CALLER_THREAD_ID }),
    );

    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.projectTitle).toBe("Primary project");
    expect(result.status).toBe("active");
    expect(result.hasMore).toBe(false);
    // The caller thread itself is part of the project and is included.
    expect(result.threads.map((thread) => thread.threadId)).toEqual([
      CALLER_THREAD_ID,
      "thread-new",
      "thread-old",
    ]);
    expect(result.totalCount).toBe(3);
    expect(result.returnedCount).toBe(3);
  });

  it("filters to archived threads and to every non-deleted thread", async () => {
    const threads = [
      makeThread({ id: "thread-active" }),
      makeThread({ id: "thread-archived", archivedAt: NOW }),
      makeThread({ id: "thread-deleted", deletedAt: NOW }),
      makeThread({ id: "thread-deleting", deletingAt: NOW }),
    ];

    const archived = await Effect.runPromise(
      listThreadsViaOrchestration({
        ...makeHarness(threads),
        callerThreadId: CALLER_THREAD_ID,
        status: "archived",
      }),
    );
    const all = await Effect.runPromise(
      listThreadsViaOrchestration({
        ...makeHarness(threads),
        callerThreadId: CALLER_THREAD_ID,
        status: "all",
      }),
    );

    expect(archived.threads.map((thread) => thread.threadId)).toEqual(["thread-archived"]);
    expect(archived.threads[0]?.archived).toBe(true);
    // Equal `updatedAt` values fall back to the thread ID tiebreak.
    expect(all.threads.map((thread) => thread.threadId)).toEqual([
      "thread-active",
      "thread-archived",
      "thread-deleting",
      CALLER_THREAD_ID,
    ]);
  });

  it("caps the page and reports that more threads exist", async () => {
    const harness = makeHarness([
      makeThread({ id: "thread-a" }),
      makeThread({ id: "thread-b" }),
      makeThread({ id: "thread-c" }),
    ]);

    const result = await Effect.runPromise(
      listThreadsViaOrchestration({ ...harness, callerThreadId: CALLER_THREAD_ID, limit: 2 }),
    );

    expect(result.limit).toBe(2);
    expect(result.totalCount).toBe(4);
    expect(result.returnedCount).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it("omits the assistant excerpt unless it is requested", async () => {
    const threads = [
      makeThread({
        id: "thread-with-reply",
        messages: [assistantMessage("Investigated the failing migration.")],
      }),
    ];

    const withoutExcerpt = await Effect.runPromise(
      listThreadsViaOrchestration({
        ...makeHarness(threads),
        callerThreadId: CALLER_THREAD_ID,
      }),
    );
    const withExcerpt = await Effect.runPromise(
      listThreadsViaOrchestration({
        ...makeHarness(threads),
        callerThreadId: CALLER_THREAD_ID,
        includeExcerpt: true,
      }),
    );

    const plainRow = withoutExcerpt.threads.find(
      (thread) => thread.threadId === "thread-with-reply",
    );
    const excerptRow = withExcerpt.threads.find(
      (thread) => thread.threadId === "thread-with-reply",
    );
    expect(plainRow).not.toHaveProperty("lastAssistantExcerpt");
    expect(plainRow?.messageCount).toBe(1);
    expect(excerptRow?.lastAssistantExcerpt).toBe("Investigated the failing migration.");
  });

  it("lists another project when it is named explicitly", async () => {
    const harness = makeHarness([
      makeThread({ id: "thread-here" }),
      makeThread({ id: "thread-there", projectId: OTHER_PROJECT_ID }),
    ]);

    const result = await Effect.runPromise(
      listThreadsViaOrchestration({
        ...harness,
        callerThreadId: CALLER_THREAD_ID,
        projectId: OTHER_PROJECT_ID,
      }),
    );

    expect(result.projectId).toBe(OTHER_PROJECT_ID);
    expect(result.projectTitle).toBe("Other project");
    expect(result.threads.map((thread) => thread.threadId)).toEqual(["thread-there"]);
  });

  it("fails for an unknown project and for an unresolvable caller", async () => {
    const harness = makeHarness([]);

    await expect(
      Effect.runPromise(
        listThreadsViaOrchestration({
          ...harness,
          callerThreadId: CALLER_THREAD_ID,
          projectId: ProjectId.makeUnsafe("project-missing"),
        }),
      ),
    ).rejects.toThrow("was not found");
    await expect(
      Effect.runPromise(
        listThreadsViaOrchestration({
          ...harness,
          callerThreadId: ThreadId.makeUnsafe("thread-missing"),
        }),
      ),
    ).rejects.toThrow("Caller thread could not be resolved.");
  });
});
