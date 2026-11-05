import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import { makeMuseTestState, threadId } from "./Adapter.failures.test.helpers.ts";

const recovered = {
  eventId: "muse-recovery-terminal-recovered",
  type: "turn.completed",
  provider: "muse",
  threadId,
  turnId: "recovered",
  createdAt: "2026-10-29T00:00:00.000Z",
  payload: { state: "completed", recoveryRedelivery: true },
} as ProviderRuntimeEvent;

describe("Muse startup recovery causal reconciliation", () => {
  it("uses the buffered terminal position, fences duplicate starts, and preserves a later unrelated start", async () => {
    const state = makeMuseTestState();
    const events: Array<ProviderRuntimeEvent> = [];
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: (event) => events.push(event),
    });
    callbacks.onNotification({ method: "turn/started", params: { turnId: "recovered" } });
    callbacks.onNotification({
      method: "turn/completed",
      params: { turnId: "recovered", terminal: "completed" },
    });
    callbacks.onNotification({ method: "turn/started", params: { turnId: "recovered" } });
    callbacks.onNotification({ method: "turn/started", params: { turnId: "new-turn" } });
    await callbacks.activate([recovered]);
    expect(events.map((event) => [event.type, event.turnId])).toEqual([
      ["turn.started", "recovered"],
      ["turn.completed", "recovered"],
      ["turn.started", "new-turn"],
    ]);
    expect(events[1]).toBe(recovered);
    expect(state.activeTurnId).toBe("new-turn");
    callbacks.onNotification({
      method: "turn/completed",
      params: { turnId: "recovered", terminal: "failed" },
    });
    expect(events).toHaveLength(3);
    expect(state.activeTurnId).toBe("new-turn");
  });
  it("delivers recovery after an earlier buffered start when no live terminal was received", async () => {
    const state = makeMuseTestState();
    const events: Array<ProviderRuntimeEvent> = [];
    const callbacks = makeMuseHostCallbacks({
      threadId,
      admissions: undefined,
      getState: () => state,
      emit: (event) => events.push(event),
    });
    callbacks.onNotification({ method: "turn/started", params: { turnId: "recovered" } });
    await callbacks.activate([recovered]);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(state.activeTurnId).toBeUndefined();
    callbacks.onNotification({ method: "turn/started", params: { turnId: "recovered" } });
    expect(events).toHaveLength(2);
    expect(state.activeTurnId).toBeUndefined();
  });
});
