import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { EventId, ThreadId, TurnId, ProviderRuntimeEvent } from "@bigbud/contracts";
import { toPromptTurnEvents } from "./Adapter.session.turn.sendTurn.events.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { makeSyntheticEventFn } from "./Adapter.stream.primitives.ts";

describe("OpenCode completion model boundary", () => {
  it("emits the provider-reported model/subprovider on the exact completed turn", async () => {
    const threadId = ThreadId.makeUnsafe("fixture"),
      turnId = TurnId.makeUnsafe("turn-A");
    const record = {
      model: "requested-A",
      providerID: "requested-account",
      sessionEpoch: 4,
      lastUsage: undefined,
    } as ActiveOpencodeSession;
    let sequence = 0;
    const nextEventId = Effect.sync(() => EventId.makeUnsafe(`fixture:${++sequence}`));
    const syntheticEventFn = makeSyntheticEventFn(
      nextEventId,
      () =>
        nextEventId.pipe(
          Effect.map((eventId) => ({ eventId, createdAt: "2026-10-17T00:00:00.000Z" })),
        ),
      "opencode",
    );
    const events = await Effect.runPromise(
      toPromptTurnEvents({
        record,
        threadId,
        turnId,
        promptInfo: {
          id: "response",
          role: "assistant",
          modelID: "actual-B",
          providerID: "actual-account",
        },
        promptParts: [],
        syntheticEventFn,
      }),
    );
    record.model = "future-global-model";
    expect(
      Schema.is(ProviderRuntimeEvent)(events.find((event) => event.type === "turn.completed")),
    ).toBe(true);
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
      turnId,
      sessionEpoch: 4,
      payload: {
        state: "completed",
        actualModelSelection: {
          provider: "opencode",
          model: "actual-B",
          subProviderID: "actual-account",
        },
      },
    });
  });
});
