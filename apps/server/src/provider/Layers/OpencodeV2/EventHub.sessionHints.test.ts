import { expect, it, vi } from "vitest";
import type { OpenCodeEvent } from "@opencode/client";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents } from "./Test.fixtures.ts";

function fixture() {
  const source = new FixtureEvents();
  const hub = new OpencodeV2EventHub({
    subscribe: (signal) => source.subscribe(signal),
    requireMarker: true,
    maxOwners: 1,
    maxQueuedEvents: 8,
    maxEventBytes: 10000,
    consumerTimeoutMs: 10000,
  });
  const onEvent = vi.fn(async () => {}),
    onDirty = vi.fn(),
    onSessionHint = vi.fn();
  hub.register({ nativeSessionId: "ses_one", location: "/one", onEvent, onDirty, onSessionHint });
  hub.start();
  return { source, hub, onEvent, onDirty, onSessionHint };
}

it.each([
  "session.permissions",
  "session.metadata.updated",
  "session.agent.selected",
  "session.model.selected",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
])("uses locationless %s only as a reread hint without invalidating admission", async (type) => {
  const f = fixture();
  try {
    await expect.poll(() => Boolean(f.hub.captureArrivalFence("ses_one"))).toBe(true);
    const arrival = f.hub.captureArrivalFence("ses_one")!;
    f.source.push({
      id: "hint",
      type,
      created: 1,
      data: { sessionID: "ses_one" },
      ...(type === "session.usage.updated"
        ? {}
        : { durable: { aggregateID: "ses_one", seq: 1, version: 1 } }),
    } as OpenCodeEvent);
    await expect.poll(() => f.onSessionHint.mock.calls.length).toBe(1);
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.onDirty).not.toHaveBeenCalled();
    expect(f.hub.generation("ses_one")).toBe(0);
    expect(arrival).toThrow(); // Still invalidates settlement observations.
  } finally {
    await f.hub.close();
  }
});

it.each([
  "missing-durable",
  "wrong-aggregate",
  "wrong-location",
  "unknown-type",
  "invalid-sequence",
  "usage-with-durable",
])("retains ambiguity protection for %s", async (scenario) => {
  const f = fixture();
  try {
    const event = {
      id: "invalid",
      type:
        scenario === "unknown-type"
          ? "session.text.delta"
          : scenario === "usage-with-durable"
            ? "session.usage.updated"
            : "session.permissions",
      created: 1,
      data: { sessionID: "ses_one" },
      ...(scenario === "missing-durable"
        ? {}
        : {
            durable: {
              aggregateID: scenario === "wrong-aggregate" ? "other" : "ses_one",
              seq: scenario === "invalid-sequence" ? -1 : 1,
              version: 1,
            },
          }),
      ...(scenario === "wrong-location" ? { location: { directory: "/other" } } : {}),
    } as OpenCodeEvent;
    f.source.push(event);
    await expect.poll(() => f.onDirty.mock.calls.length).toBe(1);
    expect(f.onDirty).toHaveBeenCalledWith("ambiguous");
    expect(f.onSessionHint).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
  } finally {
    await f.hub.close();
  }
});
