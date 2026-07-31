import {
  ProjectId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  listPinnedThreadsViaOrchestration,
  setThreadPinnedViaOrchestration,
} from "./ThreadOrchestrationTools.ts";

const CALLER_THREAD_ID = ThreadId.makeUnsafe("thread-pinned-caller");
const TARGET_THREAD_ID = ThreadId.makeUnsafe("thread-pinned-target");
const CALLER_PROJECT_ID = ProjectId.makeUnsafe("project-pinned-caller");
const TARGET_PROJECT_ID = ProjectId.makeUnsafe("project-pinned-target");
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

function makeThread(
  id: ThreadId,
  projectId: ProjectId,
  title: string,
  archivedAt: string | null = null,
): OrchestrationThread {
  return {
    id,
    projectId,
    title,
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt,
    pinnedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  };
}

function makeHarness(input?: { readonly targetArchived?: boolean }) {
  let readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    projects: [
      makeProject(CALLER_PROJECT_ID, "Caller project"),
      makeProject(TARGET_PROJECT_ID, "Target project"),
    ],
    threads: [
      makeThread(CALLER_THREAD_ID, CALLER_PROJECT_ID, "Caller thread"),
      makeThread(
        TARGET_THREAD_ID,
        TARGET_PROJECT_ID,
        "Target thread",
        input?.targetArchived ? NOW : null,
      ),
    ],
    updatedAt: NOW,
  };
  const orchestrationEngine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    readReplay: () => Effect.die("unused replay"),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type === "thread.pin" || command.type === "thread.unpin") {
          const threads = [...readModel.threads];
          const threadIndex = threads.findIndex((thread) => thread.id === command.threadId);
          if (threadIndex >= 0) {
            threads[threadIndex] = {
              ...threads[threadIndex]!,
              pinnedAt: command.type === "thread.pin" ? NOW : null,
            };
          }
          readModel = {
            ...readModel,
            threads,
          };
        }
        return { sequence: 1 };
      }),
    streamDomainEvents: Stream.empty,
  };
  return { orchestrationEngine };
}

describe("pinned thread orchestration tools", () => {
  it("pins and lists a thread from another project", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      setThreadPinnedViaOrchestration({
        ...harness,
        callerThreadId: CALLER_THREAD_ID,
        threadId: TARGET_THREAD_ID,
        pinned: true,
      }),
    );
    const result = await Effect.runPromise(
      listPinnedThreadsViaOrchestration({
        ...harness,
        callerThreadId: CALLER_THREAD_ID,
      }),
    );

    expect(result.count).toBe(1);
    expect(result.threads).toEqual([
      expect.objectContaining({
        threadId: TARGET_THREAD_ID,
        title: "Target thread",
        projectId: TARGET_PROJECT_ID,
        projectTitle: "Target project",
      }),
    ]);
  });

  it("rejects pinning an archived thread but still permits unpinning it", async () => {
    const harness = makeHarness({ targetArchived: true });

    await expect(
      Effect.runPromise(
        setThreadPinnedViaOrchestration({
          ...harness,
          callerThreadId: CALLER_THREAD_ID,
          threadId: TARGET_THREAD_ID,
          pinned: true,
        }),
      ),
    ).rejects.toThrow("is archived");
    await expect(
      Effect.runPromise(
        setThreadPinnedViaOrchestration({
          ...harness,
          callerThreadId: CALLER_THREAD_ID,
          threadId: TARGET_THREAD_ID,
          pinned: false,
        }),
      ),
    ).resolves.toMatchObject({ pinned: false });
  });
});
