import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  decodeComputerUseToolRequest,
  type ComputerUseV2ToolRequest,
} from "./computerUseToolRequest.ts";
import {
  computerUseV2ViaOrchestration,
  type SupervisedComputerUsePort,
} from "./ThreadComputerUseTools.v2.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-33333333-3333-4333-8333-333333333333");

function engine(
  runtimeMode: "approval-required" | "full-access",
  dispatched: OrchestrationCommand[],
) {
  const readModel = {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-10-27T00:00:00.000Z",
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "t",
        elevatorSummary: "t",
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
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
  } as OrchestrationReadModel;
  return {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    readReplay: () => Effect.die("unused"),
    dispatch: (command: OrchestrationCommand) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
    streamDomainEvents: Stream.empty,
  } satisfies OrchestrationEngineShape;
}

function request(raw: Record<string, unknown>): ComputerUseV2ToolRequest {
  const decoded = decodeComputerUseToolRequest(
    { surface: "desktop", schemaVersion: 2, ...raw },
    "v2",
  );
  if (decoded.kind === "legacy") throw new Error("expected a v2 request");
  return decoded;
}

const run = (input: {
  readonly request: ComputerUseV2ToolRequest;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly enabled?: boolean;
  readonly serverMode?: "web" | "desktop";
  readonly supervised?: SupervisedComputerUsePort;
  readonly dispatched?: OrchestrationCommand[];
  readonly actionTimeoutMs?: number;
}) =>
  Effect.runPromise(
    computerUseV2ViaOrchestration({
      orchestrationEngine: engine(input.runtimeMode ?? "full-access", input.dispatched ?? []),
      computerUseEnabled: input.enabled ?? true,
      serverMode: input.serverMode ?? "desktop",
      threadId: THREAD_ID,
      request: input.request,
      ...(input.supervised ? { supervised: input.supervised } : {}),
      ...(input.actionTimeoutMs ? { actionTimeoutMs: input.actionTimeoutMs } : {}),
    }),
  );

describe("computerUseV2ViaOrchestration", () => {
  it("returns contract refusals without touching the thread or runtime", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const result = await run({
      request: { kind: "refused", action: "click", code: "version_required" },
      enabled: false,
      dispatched,
    });
    expect(result).toMatchObject({ errorCode: "version_required", completion: "not_started" });
    expect(dispatched).toHaveLength(0);
  });

  it("keeps the legacy thread gates", async () => {
    const click = request({ action: "click", observationRef: "o1", x: 1, y: 1 });
    await expect(run({ request: click, enabled: false })).rejects.toThrow(/disabled/);
    await expect(run({ request: click, runtimeMode: "approval-required" })).rejects.toThrow(
      /full-access/,
    );
    await expect(run({ request: click, serverMode: "web" })).rejects.toThrow(/desktop mode/);
    // Hard safety guards are unchanged for v2 key/type/navigate/launch.
    const blocked = request({ action: "key", targetRef: "t1", key: "cmd+q" });
    await expect(run({ request: blocked })).rejects.toThrow("Force quit is blocked.");
  });

  it("fails closed with control_unavailable when no supervised port is connected", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const result = await run({ request: request({ action: "list_windows" }), dispatched });
    expect(result).toMatchObject({
      action: "list_windows",
      refused: true,
      completion: "not_started",
      errorCode: "control_unavailable",
    });
    expect(dispatched).toHaveLength(0);
  });

  it("executes through the supervised port and records both activities", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const execute = vi.fn<SupervisedComputerUsePort["execute"]>(({ operationId }) =>
      Effect.succeed({
        schemaVersion: 2,
        surface: "desktop",
        operationId,
        action: "list_windows",
        executionStatus: "succeeded",
        completion: "completed",
        summary: "Listed 2 windows.",
      }),
    );
    const result = await run({
      request: request({ action: "list_windows" }),
      supervised: { execute },
      dispatched,
    });
    expect(result.completion).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.activity.append",
    ]);
  });

  it("reports a timed-out action as an unknown effect, never as not started", async () => {
    const result = await run({
      request: request({ action: "list_windows" }),
      supervised: { execute: () => Effect.never },
      actionTimeoutMs: 5,
    });
    expect(result).toMatchObject({
      executionStatus: "timed_out",
      completion: "unknown",
      refused: false,
      errorCode: "deadline_exceeded",
    });
  });
});
