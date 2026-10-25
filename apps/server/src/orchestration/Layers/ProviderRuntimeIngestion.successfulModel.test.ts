import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  ThreadId,
  TurnId,
  EventId,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@bigbud/contracts";
import { makeSuccessfulModelRecorder } from "./ProviderRuntimeIngestion.successfulModel.ts";
import {
  lastSuccessfulThreadModel,
  successfulRuntimeModel,
} from "../../git/Layers/InternalTextGeneration.success.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

const threadId = ThreadId.makeUnsafe("fixture");
const turnId = TurnId.makeUnsafe("turn-1");
const thread = {
  id: threadId,
  modelSelection: {
    provider: "codex",
    model: "proven-model",
    options: { reasoningEffort: "high" },
  },
  session: { sessionEpoch: 1 },
} as unknown as OrchestrationThread;
const session = {
  threadId,
  provider: "codex",
  model: "proven-model",
  activeTurnId: turnId,
  sessionEpoch: 1,
} as ProviderSession;
const event = (type: "turn.started" | "turn.completed", state = "completed") =>
  ({
    type,
    eventId: EventId.makeUnsafe(`${type}:${state}`),
    provider: "codex",
    threadId,
    turnId,
    createdAt: "2026-10-16T00:00:00.000Z",
    sessionEpoch: 1,
    payload: type === "turn.completed" ? { state } : {},
  }) as ProviderRuntimeEvent;

describe("successful internal generation model evidence", () => {
  it("does not prevent chat completion when success-evidence persistence fails", async () => {
    const dispatch = vi.fn(() => Effect.fail(new Error("Fixture storage unavailable")));
    const record = makeSuccessfulModelRecorder({ dispatch } as unknown as Pick<
      OrchestrationEngineShape,
      "dispatch"
    >);
    await Effect.runPromise(record(event("turn.started"), thread, session));
    await Effect.runPromise(record(event("turn.completed"), thread, session));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("binds a runtime model to its actual provider, never a newly selected one", () => {
    expect(
      successfulRuntimeModel(session, { provider: "claudeAgent", model: "new-selection" }),
    ).toEqual({ provider: "codex", model: "proven-model" });
    expect(successfulRuntimeModel(undefined, thread.modelSelection)).toBeNull();
    expect(
      successfulRuntimeModel({ ...session, model: undefined }, thread.modelSelection),
    ).toBeNull();
  });
  it("prefers actual completion evidence for the same turn over its requested start model", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const record = makeSuccessfulModelRecorder({ dispatch } as unknown as Pick<
      OrchestrationEngineShape,
      "dispatch"
    >);
    await Effect.runPromise(record(event("turn.started"), thread, session));
    const completed = {
      ...event("turn.completed"),
      payload: {
        state: "completed",
        actualModelSelection: { provider: "codex", model: "actual-model-B" },
      },
    } as ProviderRuntimeEvent;
    await Effect.runPromise(
      record(completed, thread, { ...session, model: "unrelated-current-model" }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: expect.objectContaining({
          payload: { provider: "codex", model: "actual-model-B" },
        }),
      }),
    );
  });
  it("never infers a completed turn's model from a mutable global session snapshot", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const record = makeSuccessfulModelRecorder({ dispatch } as unknown as Pick<
      OrchestrationEngineShape,
      "dispatch"
    >);
    await Effect.runPromise(
      record(event("turn.completed"), thread, {
        ...session,
        activeTurnId: TurnId.makeUnsafe("next-turn"),
        model: "next-model",
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects stale completion epochs and completion evidence for another current turn", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const record = makeSuccessfulModelRecorder({ dispatch } as unknown as Pick<
      OrchestrationEngineShape,
      "dispatch"
    >);
    const completed = {
      ...event("turn.completed"),
      payload: { state: "completed", actualModelSelection: { provider: "codex", model: "actual" } },
    } as ProviderRuntimeEvent;
    await Effect.runPromise(record({ ...completed, sessionEpoch: 0 }, thread, session));
    await Effect.runPromise(
      record(
        completed,
        {
          ...thread,
          latestTurn: { turnId: TurnId.makeUnsafe("next-turn") },
        } as OrchestrationThread,
        session,
      ),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("records only successful completion and retains the captured start pair after selection changes", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const engine = { dispatch } as unknown as Pick<OrchestrationEngineShape, "dispatch">;
    const record = makeSuccessfulModelRecorder(engine);
    await Effect.runPromise(record(event("turn.started"), thread, session));
    expect(dispatch).not.toHaveBeenCalled();
    const changed = {
      ...thread,
      modelSelection: { provider: "claudeAgent" as const, model: "unsuccessful-new-model" },
    };
    await Effect.runPromise(
      record(event("turn.completed"), changed, {
        ...session,
        provider: "claudeAgent",
        model: "unsuccessful-new-model",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.activity.append",
        activity: expect.objectContaining({
          kind: "text-generation.model-succeeded",
          payload: thread.modelSelection,
        }),
      }),
    );
  });
  it.each(["failed", "interrupted", "cancelled"])(
    "does not replace success evidence on %s",
    async (state) => {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
      const record = makeSuccessfulModelRecorder({ dispatch } as unknown as Pick<
        OrchestrationEngineShape,
        "dispatch"
      >);
      await Effect.runPromise(record(event("turn.started"), thread, session));
      await Effect.runPromise(record(event("turn.completed", state), thread, session));
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it("recovers the latest durable successful model while ignoring later selection/failure activities", () => {
    const activities = [
      { kind: "text-generation.model-succeeded", payload: { provider: "codex", model: "older" } },
      {
        kind: "text-generation.model-succeeded",
        payload: { provider: "claudeAgent", model: "latest-success" },
      },
      { kind: "turn.failed", payload: { provider: "copilot", model: "failed-model" } },
    ] as unknown as OrchestrationThread["activities"];
    expect(lastSuccessfulThreadModel({ activities })).toEqual({
      provider: "claudeAgent",
      model: "latest-success",
    });
    expect(lastSuccessfulThreadModel({ activities: [] })).toBeNull();
  });
});
