import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { BACKEND_DRAIN_WS_METHODS } from "@bigbud/contracts/server/backendDrain.ts";

import {
  decideBackendDrain,
  pendingBackendDrain,
  requestBackendDrainConsent,
  subscribeBackendDrainConsent,
} from "../startup/backendDrain.consent.ts";
import { makeWsRpcBackendDrainHandlers } from "./wsRpcHandlers.backendDrain.ts";
import { authorizeWebsocketRpcConnection } from "./wsConnectionAuthorization.ts";

const pane = (id: string, surface: "local" | "direct-ssh" | "remote-agent", keepMode = false) => ({
  paneId: `thread-${id}:terminal-${id}`,
  threadId: `thread-${id}`,
  threadTitle: `Thread ${id}`,
  title: `Terminal ${id}`,
  surface,
  leaseId: `thread-${id}:terminal-${id}`,
  keepMode,
});

const handlers = makeWsRpcBackendDrainHandlers();

async function published() {
  const listener = new Promise<string>((resolve) => {
    const unsubscribe = subscribeBackendDrainConsent((pending) => {
      if (!pending) return;
      unsubscribe();
      resolve(pending.drainId);
    });
  });
  // The publish happens when the core asks; resolve it in the background.
  const consent = Effect.runPromise(
    requestBackendDrainConsent({
      panes: [pane("a", "direct-ssh"), pane("b", "local")],
      timeoutMs: 5_000,
      drainId: "drain-test",
    }),
  );
  const drainId = await listener;
  return { drainId, consent };
}

describe("backend drain WebSocket consent", () => {
  it("is reachable only through the authenticated WebSocket route", () => {
    expect(
      authorizeWebsocketRpcConnection({
        mode: "local",
        authToken: "secret",
        url: "ws://localhost/ws",
        headers: {},
      }),
    ).toBe("unauthorized");
    expect(
      authorizeWebsocketRpcConnection({
        mode: "local",
        authToken: "secret",
        url: "ws://localhost/ws?token=secret",
        headers: {},
      }),
    ).toBe("authorized");
  });

  it("publishes a bounded snapshot and re-delivers the same drain on reconnect", async () => {
    const { drainId, consent } = await published();
    const first = await Effect.runPromise(handlers[BACKEND_DRAIN_WS_METHODS.get]());
    const second = await Effect.runPromise(handlers[BACKEND_DRAIN_WS_METHODS.get]());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      drainId,
      panes: [{ surface: "direct-ssh" }, { surface: "local" }],
    });
    expect(JSON.stringify(first)).not.toContain("/");
    decideBackendDrain(drainId, { kind: "cancel" });
    await expect(consent).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("accepts one decision and returns already-decided to a second client", async () => {
    const { drainId, consent } = await published();
    const [one, two] = await Promise.all([
      Effect.runPromise(
        handlers[BACKEND_DRAIN_WS_METHODS.decide]({ drainId, decision: "drain-now" }),
      ),
      Effect.runPromise(
        handlers[BACKEND_DRAIN_WS_METHODS.decide]({ drainId, decision: "save-and-close" }),
      ),
    ]);
    expect([one.status, two.status].toSorted()).toEqual(["accepted", "already-decided"]);
    await expect(consent).resolves.toMatchObject({ kind: "proceed", choice: "drain-now" });
    expect(pendingBackendDrain()).toBeUndefined();
  });

  it("refuses an unknown or late decision with a typed error", async () => {
    const { drainId, consent } = await published();
    await expect(
      Effect.runPromise(handlers[BACKEND_DRAIN_WS_METHODS.decide]({ drainId, decision: "cancel" })),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(consent).resolves.toMatchObject({ kind: "cancelled" });
    await expect(
      Effect.runPromise(
        handlers[BACKEND_DRAIN_WS_METHODS.decide]({ drainId: "unknown", decision: "cancel" }),
      ),
    ).rejects.toMatchObject({ _tag: "BackendDrainConsentError" });
  });
});
