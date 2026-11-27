import { BACKEND_DRAIN_WS_METHODS } from "@bigbud/contracts/server/backendDrain.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";

import { makeWsRpcBackendDrainHandlers } from "../ws/wsRpcHandlers.backendDrain.ts";
import {
  BACKEND_DRAIN_UI_PRESENCE_MS,
  decideBackendDrain,
  hasBackendDrainUi,
  noteBackendDrainUiPoll,
  pendingBackendDrain,
  requestBackendDrainConsent,
  resetBackendDrainUiPresenceForTest,
} from "./backendDrain.consent.ts";

// W6 regression: the web consent host only polls `getBackendDrainConsent`; nothing ever
// subscribed in-process, so every `ui` drain (the desktop updater's) was `consent-required`.

afterEach(() => resetBackendDrainUiPresenceForTest());

const request = (drainId: string) =>
  requestBackendDrainConsent({ panes: [], timeoutMs: 5_000, drainId });

describe("backend drain UI presence", () => {
  it("refuses with consent-required when no UI has polled", async () => {
    expect(hasBackendDrainUi()).toBe(false);
    expect(await Effect.runPromise(request("drain-none"))).toEqual({ kind: "consent-required" });
  });

  it("treats a stale poll as no UI", () => {
    noteBackendDrainUiPoll(1_000);
    expect(hasBackendDrainUi(1_000 + BACKEND_DRAIN_UI_PRESENCE_MS)).toBe(true);
    expect(hasBackendDrainUi(1_001 + BACKEND_DRAIN_UI_PRESENCE_MS)).toBe(false);
  });

  it("publishes to a polling UI through the RPC and honours its Cancel", async () => {
    const handlers = makeWsRpcBackendDrainHandlers();
    expect(await Effect.runPromise(handlers[BACKEND_DRAIN_WS_METHODS.get]())).toBeNull();
    expect(hasBackendDrainUi()).toBe(true);
    const fiber = Effect.runFork(request("drain-cancel"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = await Effect.runPromise(handlers[BACKEND_DRAIN_WS_METHODS.get]());
    expect(snapshot?.drainId).toBe("drain-cancel");
    expect(
      await Effect.runPromise(
        handlers[BACKEND_DRAIN_WS_METHODS.decide]({ drainId: "drain-cancel", decision: "cancel" }),
      ),
    ).toEqual({ status: "accepted", decision: "cancel" });
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual({ kind: "cancelled" });
    expect(pendingBackendDrain()).toBeUndefined();
  });

  it("proceeds with the polling UI's Drain choice", async () => {
    noteBackendDrainUiPoll();
    const fiber = Effect.runFork(request("drain-proceed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decideBackendDrain("drain-proceed", { kind: "proceed", choice: "drain-now" })).toBe(
      "drained",
    );
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual({
      kind: "proceed",
      choice: "drain-now",
    });
  });
});
