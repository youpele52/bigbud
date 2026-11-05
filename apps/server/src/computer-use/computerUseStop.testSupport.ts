import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeComputerUseStop } from "./computerUseStop.ts";
import { makeComputerUseActivity } from "./Layers/ComputerUseActivity.ts";
import type { CuaDriverShape } from "./Services/CuaDriver.ts";

export const threadId = (id: string) => ThreadId.makeUnsafe(`thread-${id}`);
export const turnId = (id: string) => TurnId.makeUnsafe(`turn-${id}`);

type ReadModelThread = OrchestrationReadModel["threads"][number];

/** A full-access thread whose session runs `activeTurnId` (none when null), started at `startedAt`. */
export function makeThread(
  id: ThreadId,
  activeTurnId: TurnId | null,
  startedAt = "2026-10-28T00:00:00.000Z",
): ReadModelThread {
  const at = "2026-10-28T00:00:00.000Z";
  return {
    id,
    projectId: ProjectId.makeUnsafe("project-computer-use-stop"),
    title: "Computer use stop",
    elevatorSummary: "",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: activeTurnId
      ? {
          turnId: activeTurnId,
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: id,
      status: activeTurnId ? "running" : "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId,
      sessionEpoch: 3,
      reason: null,
      lastError: null,
      updatedAt: at,
    },
    watchingThreads: [],
  };
}

/** Engine double: a mutable read model, recorded dispatches, and injectable domain events. */
export function makeFakeEngine(threads: ReadonlyArray<ReadModelThread>) {
  const state = { threads: [...threads] };
  const dispatched: OrchestrationCommand[] = [];
  const engine: OrchestrationEngineShape = {
    getReadModel: () =>
      Effect.sync(() => ({
        snapshotSequence: 1,
        projects: [],
        updatedAt: "2026-10-28T00:00:00.000Z",
        threads: state.threads,
      })),
    readEvents: () => Stream.empty,
    readReplay: () => Effect.die("unused replay"),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
  };
  return { engine, dispatched, state };
}

export const DESKTOP = {
  threadId: threadId("desktop"),
  turnId: turnId("d1"),
  surface: "desktop" as const,
};
export const BROWSER = {
  threadId: threadId("browser"),
  turnId: turnId("b1"),
  surface: "browser" as const,
};
export const BYSTANDER = { threadId: threadId("bystander"), turnId: turnId("x1") };

export function makeStopDriver(reset: Effect.Effect<"reset" | "idle"> = Effect.succeed("reset")) {
  const stopAllActivity = vi.fn((_reason: string) => reset);
  return { driver: { stopAllActivity } as unknown as CuaDriverShape, stopAllActivity };
}

export const setupStop = (driver: CuaDriverShape | null, nowMs = () => Date.now()) =>
  Effect.gen(function* () {
    const activity = yield* makeComputerUseActivity;
    const fake = makeFakeEngine([
      makeThread(DESKTOP.threadId, DESKTOP.turnId),
      makeThread(BROWSER.threadId, BROWSER.turnId),
      makeThread(BYSTANDER.threadId, BYSTANDER.turnId),
    ]);
    const deps = { activity, engine: fake.engine, driver, nowMs };
    return { ...fake, activity, deps, stop: makeComputerUseStop(deps) };
  });
