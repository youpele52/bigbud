import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asEventId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

const THREAD = asThreadId("thread-1");

async function settleTurn(harness: Awaited<ReturnType<typeof createHarness>>, turnId: string) {
  harness.emit({
    type: "turn.started",
    eventId: asEventId(`evt-start-${turnId}`),
    provider: "claudeAgent",
    createdAt: new Date().toISOString(),
    threadId: THREAD,
    turnId: asTurnId(turnId),
  });
  harness.emit({
    type: "turn.completed",
    eventId: asEventId(`evt-done-${turnId}`),
    provider: "claudeAgent",
    createdAt: new Date().toISOString(),
    threadId: THREAD,
    turnId: asTurnId(turnId),
    payload: { state: "completed" },
  });
  await waitForThread(
    harness.engine,
    (thread) => thread.session?.status === "ready" && thread.latestTurn?.turnId === turnId,
  );
}

const suggestion = (eventId: string, turnId: string, text: string) => ({
  type: "turn.prompt-suggestion" as const,
  eventId: asEventId(eventId),
  provider: "claudeAgent" as const,
  createdAt: new Date().toISOString(),
  threadId: THREAD,
  turnId: asTurnId(turnId),
  payload: { suggestion: text, source: "native" as const },
});

const suggestionsOf = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  await harness.drain();
  const readModel = await Effect.runPromise(harness.engine.getReadModel());
  const thread = readModel.threads.find((entry) => entry.id === THREAD);
  return (thread?.activities ?? []).filter((activity) => activity.kind === "prompt.suggestion");
};

describe("ProviderRuntimeIngestion prompt suggestions", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("projects a native suggestion onto the latest settled turn and ignores a stale one", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    await settleTurn(harness, "turn-1");
    await settleTurn(harness, "turn-2");

    harness.emit(suggestion("evt-stale", "turn-1", "Explain the first change again"));
    harness.emit(suggestion("evt-fresh", "turn-2", "  Add tests for\nthe new parser  "));

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "prompt.suggestion"),
    );
    const activities = thread.activities.filter(
      (activity) => activity.kind === "prompt.suggestion",
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      turnId: "turn-2",
      tone: "info",
      payload: {
        suggestion: "Add tests for the new parser",
        source: "native",
        provider: "claudeAgent",
      },
    });
  });

  it("drops suggestions when the setting is off", async () => {
    const harness = await createHarness({
      provider: "claudeAgent",
      serverSettings: { promptSuggestions: false },
    });
    await settleTurn(harness, "turn-1");
    harness.emit(suggestion("evt-off", "turn-1", "Add tests for the new parser"));
    expect(await suggestionsOf(harness)).toHaveLength(0);
  });

  it("drops a suggestion that arrives while the next turn is running", async () => {
    const harness = await createHarness({ provider: "claudeAgent" });
    await settleTurn(harness, "turn-1");
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-start-turn-2"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: THREAD,
      turnId: asTurnId("turn-2"),
    });
    await waitForThread(harness.engine, (thread) => thread.session?.activeTurnId === "turn-2");
    harness.emit(suggestion("evt-late", "turn-1", "Add tests for the new parser"));
    expect(await suggestionsOf(harness)).toHaveLength(0);
  });
});
