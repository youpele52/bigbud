import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { BackendDrainRequest } from "./backendDrain.protocol.ts";
import {
  decideBackendDrain,
  pendingBackendDrain,
  subscribeBackendDrainConsent,
} from "./backendDrain.consent.ts";
import { makeLiveBackendDrainHandler, type LiveBackendDrainDeps } from "./backendDrain.live.ts";
import type { LegacyDrainPane } from "../ssh/sshLegacyDrain.ts";

const request = (consent: "ui" | "non-interactive" = "non-interactive"): BackendDrainRequest => ({
  v: 1,
  token: "a".repeat(64),
  method: "drain",
  artifactId: "build-a",
  consent,
  waitMs: 5_000,
});

const pane = (
  suffix: string,
  surface: LegacyDrainPane["surface"],
  keepMode = false,
): LegacyDrainPane => ({
  paneId: `thread-${suffix}:terminal-${suffix}`,
  threadId: `thread-${suffix}`,
  threadTitle: `Thread ${suffix}`,
  title: `Terminal ${suffix}`,
  surface,
  leaseId: `thread-${suffix}:terminal-${suffix}`,
  keepMode,
});

function deps(overrides: Partial<LiveBackendDrainDeps> = {}) {
  const events: string[] = [];
  const panes = [
    pane("local", "local"),
    pane("direct", "direct-ssh", true),
    pane("kept", "remote-agent", true),
    pane("remote", "remote-agent", false),
  ];
  return {
    events,
    deps: {
      profileScope: "backend",
      artifactId: "build-a",
      listPanes: () => Effect.succeed(panes),
      closePane: (closed: LegacyDrainPane) =>
        Effect.sync(() => events.push(`close:${closed.paneId}`)),
      stopMonitors: Effect.sync(() => events.push("monitors")),
      stopRelays: Effect.sync(() => events.push("relays")),
      stopProviders: Effect.sync(() => events.push("providers")),
      closeOwnedMasters: Effect.sync(() => {
        events.push("masters");
        return { closed: 1, failed: 0 };
      }),
      commit: () => Effect.sync(() => events.push("commit")),
      releaseLock: Effect.sync(() => events.push("release")),
      ...overrides,
    } as LiveBackendDrainDeps,
  };
}

describe("live backend drain handler", () => {
  it("classifies panes, closes only drainable ones, and runs the core in order", async () => {
    const { deps: live, events } = deps();
    const handler = makeLiveBackendDrainHandler(live);
    await expect(handler(request())).resolves.toEqual({
      v: 1,
      ok: true,
      status: "drained",
      stops: [],
    });
    expect(events).toEqual([
      "monitors",
      "relays",
      "providers",
      "close:thread-direct:terminal-direct",
      "close:thread-remote:terminal-remote",
      "masters",
      "commit",
      "release",
    ]);
  });

  it("refuses an unknown artifact and a second concurrent drain", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps: live } = deps({
      stopMonitors: Effect.promise(() => blocker),
    });
    const handler = makeLiveBackendDrainHandler(live);
    const first = handler(request());
    await expect(handler(request())).resolves.toMatchObject({ status: "busy" });
    await expect(handler({ ...request(), artifactId: "other" })).resolves.toMatchObject({
      status: "unknown-artifact",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "drained" });
  });

  it("returns consent-required without a UI and leaves everything running", async () => {
    const { deps: live, events } = deps();
    const handler = makeLiveBackendDrainHandler(live);
    await expect(handler(request("ui"))).resolves.toEqual({
      v: 1,
      ok: true,
      status: "consent-required",
    });
    expect(events).toEqual([]);
  });

  it("cancel writes no marker, closes nothing and releases nothing", async () => {
    const { deps: live, events } = deps({ consentTimeoutMs: 2_000 });
    const handler = makeLiveBackendDrainHandler(live);
    const unsubscribe = subscribeBackendDrainConsent((pending) => {
      if (!pending) return;
      expect(decideBackendDrain(pending.drainId, { kind: "cancel" })).toBe("cancelled");
      expect(decideBackendDrain(pending.drainId, { kind: "cancel" })).toBe("refused");
    });
    try {
      await expect(handler(request("ui"))).resolves.toMatchObject({ status: "cancelled" });
      expect(events).toEqual([]);
      expect(pendingBackendDrain()).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("accepts exactly one UI proceed decision and refuses a late duplicate", async () => {
    const { deps: live, events } = deps({ consentTimeoutMs: 2_000 });
    const handler = makeLiveBackendDrainHandler(live);
    let drainId = "";
    const unsubscribe = subscribeBackendDrainConsent((pending) => {
      if (!pending || drainId) return;
      drainId = pending.drainId;
      expect(decideBackendDrain(drainId, { kind: "proceed", choice: "save-and-close" })).toBe(
        "drained",
      );
    });
    try {
      await expect(handler(request("ui"))).resolves.toMatchObject({ status: "drained" });
      expect(decideBackendDrain(drainId, { kind: "cancel" })).toBe("refused");
      expect(events).toEqual([
        "monitors",
        "relays",
        "providers",
        "close:thread-direct:terminal-direct",
        "close:thread-remote:terminal-remote",
        "masters",
        "commit",
        "release",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("no marker or release on a core failure", async () => {
    const { deps: live, events } = deps({
      commit: () => Effect.fail(new Error("commit failed")),
    });
    const handler = makeLiveBackendDrainHandler(live);
    await expect(handler(request())).resolves.toMatchObject({ ok: false });
    expect(events).not.toContain("commit");
    expect(events).not.toContain("release");
  });

  it("answers a tagged failure's detail instead of an empty message", async () => {
    class DetailError extends Data.TaggedError("DetailError")<{ readonly detail: string }> {}
    const { deps: live } = deps({
      commit: () => Effect.fail(new DetailError({ detail: "marker conflict" })),
    });
    const handler = makeLiveBackendDrainHandler(live);
    await expect(handler(request())).resolves.toEqual({
      v: 1,
      ok: false,
      error: { code: "failed", message: "Writing the retirement marker failed." },
    });
  });
});
