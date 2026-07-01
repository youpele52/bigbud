import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { computerUseViaOrchestration } from "./ThreadComputerUseTools.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

function makeReadModel(input?: {
  readonly latestUserMessageAt: string;
  readonly computerUseStartedAt: string;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-06-30T00:00:00.000Z",
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Computer use thread",
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: input
          ? [
              {
                id: MessageId.makeUnsafe("message-user-1"),
                role: "user",
                text: "Use the computer.",
                turnId: null,
                streaming: false,
                createdAt: input.latestUserMessageAt,
                updatedAt: input.latestUserMessageAt,
              },
            ]
          : [],
        proposedPlans: [],
        activities: input
          ? [
              {
                id: EventId.makeUnsafe("event-computer-use-started-1"),
                tone: "tool",
                kind: "tool.started",
                summary: "Computer use started",
                payload: {
                  itemType: "mcp_tool_call",
                  title: "computer_use",
                  detail: "Capture browser state",
                  data: { action: { action: "capture" } },
                },
                turnId: null,
                createdAt: input.computerUseStartedAt,
              },
            ]
          : [],
        checkpoints: [],
        session: null,
        watchingThreads: [],
      },
    ],
  };
}

function makeOrchestrationEngine(input: {
  readonly readModel: OrchestrationReadModel;
  readonly dispatched: OrchestrationCommand[];
}): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed(input.readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) => {
      input.dispatched.push(command);
      return Effect.succeed({ sequence: input.dispatched.length });
    },
    streamDomainEvents: Stream.empty,
  };
}

describe("computerUseViaOrchestration limits", () => {
  it("requires a user check-in after the configured computer-use interval", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() =>
      Effect.succeed({ surface: "browser" as const, action: "capture" as const, summary: "" }),
    );
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-06-30T00:12:00.000Z"));

    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

            return yield* computerUseViaOrchestration({
              attachmentsDir,
              computerUse: { execute, dispose: Effect.void },
              computerUseEnabled: true,
              fileSystem,
              orchestrationEngine: makeOrchestrationEngine({
                readModel: makeReadModel({
                  latestUserMessageAt: "2026-06-30T00:00:00.000Z",
                  computerUseStartedAt: "2026-06-30T00:01:00.000Z",
                }),
                dispatched,
              }),
              path,
              serverMode: "desktop",
              threadId: THREAD_ID,
              action: { action: "capture" },
              checkInIntervalMs: 10 * 60_000,
            });
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow("Ask the user whether to continue");
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(execute).not.toHaveBeenCalled();
  });

  it("times out long-running computer-use actions", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn(() => Effect.never);

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });

          return yield* computerUseViaOrchestration({
            attachmentsDir,
            computerUse: { execute, dispose: Effect.void },
            computerUseEnabled: true,
            fileSystem,
            orchestrationEngine: makeOrchestrationEngine({
              readModel: makeReadModel(),
              dispatched,
            }),
            path,
            serverMode: "desktop",
            threadId: THREAD_ID,
            action: { action: "capture" },
            actionTimeoutMs: 1,
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("timed out");
  });
});
