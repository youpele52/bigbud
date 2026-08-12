import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  GetProjectThreadSummariesResult,
  GetSidebarThreadCatalogResult,
  GetStartupProjectCatalogInput,
  GetStartupProjectCatalogResult,
} from "./orchestration.catalog";
import { OrchestrationRpcSchemas } from "./orchestration.rpc";

it.effect("decodes sidebar catalog membership", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(GetSidebarThreadCatalogResult)({
      projectionSequence: 1,
      threads: [],
      recentThreadIds: ["recent-thread"],
      pinnedThreadIds: ["pinned-thread"],
    });

    assert.deepEqual(result.recentThreadIds.map(String), ["recent-thread"]);
    assert.deepEqual(result.pinnedThreadIds.map(String), ["pinned-thread"]);
  }),
);

it.effect("decodes structured catalog cursors", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(GetStartupProjectCatalogInput)({
      scope: "local",
      limit: 2,
      cursor: { lastUsedAt: "2026-01-03T00:00:00.000Z", projectId: "project-1" },
    });
    assert.equal(input.cursor?.projectId, "project-1");
    assert.equal(input.scope, "local");
  }),
);

it.effect("decodes thread summaries without history arrays", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(GetProjectThreadSummariesResult)({
      projectionSequence: 4,
      projectId: "project-1",
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          purpose: "standard",
          elevatorSummary: "Summary",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          providerRuntimeExecutionTargetId: "ssh:provider",
          workspaceExecutionTargetId: "ssh:workspace",
          executionTargetId: "ssh:legacy",
          branch: "feature/remote",
          worktreePath: "/worktrees/remote",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          latestUserMessageAt: "2026-01-03T00:00:00.000Z",
          pinnedAt: "2026-01-03T00:00:00.000Z",
          sessionStatus: "running",
          providerName: "codex",
          activeTurnId: null,
          latestTurnState: null,
          isWatching: false,
          isWatched: false,
          isDelegated: false,
          isAwaitingApproval: true,
        },
      ],
    });
    assert.equal(result.threads[0]?.pinnedAt, "2026-01-03T00:00:00.000Z");
    assert.equal(result.threads[0]?.worktreePath, "/worktrees/remote");
    assert.equal("messages" in (result.threads[0] ?? {}), false);
  }),
);

it.effect("decodes project execution targets", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(GetStartupProjectCatalogResult)({
      projectionSequence: 4,
      projects: [
        {
          id: "project-1",
          title: "Remote",
          providerRuntimeExecutionTargetId: "ssh:provider",
          workspaceExecutionTargetId: "ssh:workspace",
          executionTargetId: "ssh:legacy",
          workspaceRoot: "/workspace",
          lastUsedAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          deletingAt: null,
          threadCount: 0,
          exceptionalThreadCount: 0,
          hasExceptionalThreads: false,
        },
      ],
    });
    assert.equal(result.projects[0]?.workspaceExecutionTargetId, "ssh:workspace");
  }),
);

it.effect("decodes typed unavailable replay ranges", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(OrchestrationRpcSchemas.replayEvents.output)({
      requestedFromSequenceExclusive: 2,
      retainedFromSequenceExclusive: 5,
      earliestAvailableSequence: 6,
      latestSequence: 9,
      availability: "gap",
      complete: false,
      events: [],
    });
    assert.equal(result.availability, "gap");
    assert.equal(result.retainedFromSequenceExclusive, 5);
  }),
);
