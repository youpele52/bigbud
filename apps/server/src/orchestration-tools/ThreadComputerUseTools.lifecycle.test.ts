import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ComputerUseShape } from "../computer-use/Services/ComputerUse.ts";
import { ComputerUseError } from "../computer-use/Services/ComputerUse.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { computerUseViaOrchestration } from "./ThreadComputerUseTools.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-06-30T00:00:00.000Z",
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Computer use lifecycle",
        elevatorSummary: "Computer use lifecycle",
        elevatorSummaryMessageCount: 0,
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
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        watchingThreads: [],
      },
    ],
  };
}

function engine(dispatched: OrchestrationCommand[]): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed(readModel()),
    readEvents: () => Stream.empty,
    readReplay: () => Effect.die("unused replay"),
    dispatch: (command) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
    streamDomainEvents: Stream.empty,
  };
}

function operation(input: {
  readonly computerUse: ComputerUseShape;
  readonly dispatched: OrchestrationCommand[];
  readonly actionTimeoutMs?: number;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });
    return yield* computerUseViaOrchestration({
      attachmentsDir,
      computerUse: input.computerUse,
      computerUseEnabled: true,
      fileSystem,
      orchestrationEngine: engine(input.dispatched),
      path,
      serverMode: "desktop",
      threadId: THREAD_ID,
      action: { action: "capture", surface: "browser" },
      ...(input.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: input.actionTimeoutMs }),
    });
  }).pipe(Effect.provide(NodeServices.layer));
}

function terminalData(dispatched: OrchestrationCommand[]): Record<string, unknown> | undefined {
  return dispatched.flatMap((command) =>
    command.type === "thread.activity.append" &&
    command.activity.kind === "tool.completed" &&
    command.activity.payload &&
    typeof command.activity.payload === "object"
      ? [(command.activity.payload as { data?: Record<string, unknown> }).data ?? {}]
      : [],
  )[0];
}

describe("computerUseViaOrchestration lifecycle", () => {
  it("records one timed-out terminal activity", async () => {
    const dispatched: OrchestrationCommand[] = [];
    await expect(
      Effect.runPromise(
        operation({
          computerUse: { execute: () => Effect.never, dispose: Effect.void },
          dispatched,
          actionTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow("timed out");

    expect(terminalData(dispatched)?.executionStatus).toBe("timed_out");
    expect(dispatched.filter((command) => command.type === "thread.activity.append")).toHaveLength(
      2,
    );
  });

  it("records one failed terminal activity for a driver error", async () => {
    const dispatched: OrchestrationCommand[] = [];
    await expect(
      Effect.runPromise(
        operation({
          computerUse: {
            execute: () => Effect.fail(new ComputerUseError({ message: "driver failed" })),
            dispose: Effect.void,
          },
          dispatched,
        }),
      ),
    ).rejects.toThrow("driver failed");

    expect(terminalData(dispatched)?.executionStatus).toBe("failed");
    expect(dispatched.filter((command) => command.type === "thread.activity.append")).toHaveLength(
      2,
    );
  });

  it("records one cancelled terminal activity on interruption", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const fiber = Effect.runFork(
      operation({
        computerUse: { execute: () => Effect.never, dispose: Effect.void },
        dispatched,
        actionTimeoutMs: 60_000,
      }),
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    fiber.interruptUnsafe();
    await vi.waitFor(() => expect(terminalData(dispatched)?.executionStatus).toBe("cancelled"));
    expect(dispatched.filter((command) => command.type === "thread.activity.append")).toHaveLength(
      2,
    );
  });
});
