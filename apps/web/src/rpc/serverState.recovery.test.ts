import type { ServerConfigStreamEvent } from "@bigbud/contracts/server/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { SocketCloseError } from "effect/unstable/socket/Socket";
import { Cause, Duration } from "effect";

import { getServerConfigReadiness, retryServerConfigSync } from "./serverConfigReadiness";
import { getServerConfig, resetServerStateForTests, startServerStateSync } from "./serverState";
import type { StreamSubscriptionOptions } from "./wsRpcClient.types";
import { serverConfigFixture } from "./serverConfig.test.fixture";

function harness() {
  let listener!: (event: ServerConfigStreamEvent) => void;
  let policy!: StreamSubscriptionOptions;
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const client = {
    getConfig: vi.fn(() => new Promise<typeof serverConfigFixture>(() => undefined)),
    subscribeLifecycle: vi.fn(() => vi.fn()),
    subscribeConfig: vi.fn((next: typeof listener, options?: StreamSubscriptionOptions) => {
      listener = next;
      policy = options!;
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
  };
  return {
    client,
    stops,
    event: (event: ServerConfigStreamEvent) => listener(event),
    policy: () => policy,
    listener: () => listener,
  };
}

const cleanups: Array<() => void> = [];
beforeEach(() => resetServerStateForTests());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  resetServerStateForTests();
});

describe("server config recovery", () => {
  it("arms only initial snapshot application and classifies its bounded timeout", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    const deadline = h.policy().initialApplication!;
    expect(Duration.toMillis(Duration.fromInputUnsafe(deadline.timeout))).toBe(15_000);
    expect(deadline.isApplied?.()).toBe(false);
    h.event({ version: 1, type: "providerStatuses", payload: { providers: [] } });
    expect(deadline.isApplied?.()).toBe(false);
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(deadline.isApplied?.()).toBe(true);
    h.policy().onResubscribe?.();
    expect(deadline.isApplied?.()).toBe(false);
    h.policy().shouldRetry?.(new Cause.TimeoutError());
    expect(getServerConfigReadiness().failure).toBe("initial_snapshot_timeout");
  });

  it("marks a terminal unsupported stream exhausted even after an earlier timeout", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    h.policy().shouldRetry?.(new Cause.TimeoutError());
    h.policy().onError?.(new Error("Unknown request tag: server.subscribeConfig"));
    expect(getServerConfigReadiness()).toMatchObject({
      stream: "exhausted",
      failure: "incompatible",
    });
    retryServerConfigSync({ onlyIfStopped: true });
    expect(h.client.subscribeConfig).toHaveBeenCalledTimes(2);
  });

  it("does not announce a cached delta as live before the stream's initial snapshot applies", async () => {
    const h = harness();
    h.client.getConfig.mockResolvedValueOnce(serverConfigFixture);
    cleanups.push(startServerStateSync(h.client));
    await vi.waitFor(() => expect(getServerConfig()).toEqual(serverConfigFixture));
    h.event({ version: 1, type: "providerStatuses", payload: { providers: [] } });
    expect(h.policy().initialApplication?.isApplied?.()).toBe(false);
    expect(getServerConfigReadiness().stream).toBe("pending");
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfigReadiness().stream).toBe("live");
  });
  it("surfaces a fallback failure without retaining error values or credentials", async () => {
    const h = harness();
    h.client.getConfig.mockRejectedValueOnce(
      new Error("token=private-value /private/provider/path"),
    );
    cleanups.push(startServerStateSync(h.client));
    await vi.waitFor(() => expect(getServerConfigReadiness().fallback).toBe("failed"));
    expect(getServerConfigReadiness().failure).toBe("fallback_failed");
    expect(JSON.stringify(getServerConfigReadiness())).not.toContain("private");
    expect(getServerConfig()).toBeNull();
  });

  it("exhausts repeated snapshots followed by failures without resetting the budget", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
      expect(h.policy().shouldRetry?.(new Error("invalid update"))).toBe(attempt < 3);
    }
    expect(getServerConfigReadiness()).toMatchObject({ stream: "exhausted", failures: 3 });
    expect(getServerConfig()).toEqual(serverConfigFixture);
  });

  it("resets the failure budget after successfully applied config remains live", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    expect(h.policy().shouldRetry?.(new Error("first failure"))).toBe(true);
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    now.mockReturnValue(31_001);
    expect(h.policy().shouldRetry?.(new Error("later failure"))).toBe(true);
    expect(getServerConfigReadiness().failures).toBe(1);
  });

  it("recognizes the first successfully applied snapshot as progress, not mere receipt", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    h.policy().shouldRetry?.(new Error("first failure"));
    h.policy().shouldRetry?.(new Error("second failure"));
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfigReadiness().failures).toBe(0);
    expect(h.policy().shouldRetry?.(new Error("failure after establishing baseline"))).toBe(true);
    expect(getServerConfigReadiness().failures).toBe(1);
  });

  it("lets the existing socket reconnect owner run before retrying config requests", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    const error = new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) });
    h.policy().shouldRetry?.(error);
    const delay = h.policy().retryDelay;
    expect(typeof delay).toBe("function");
    if (typeof delay === "function") expect(delay({ error, attempt: 1 })).toBe(1_000);
  });

  it("permits explicit config retry, cancels its old owner, and fences old callbacks", () => {
    const h = harness();
    cleanups.push(startServerStateSync(h.client));
    const oldListener = h.listener();
    for (let attempt = 0; attempt < 3; attempt += 1) h.policy().shouldRetry?.(new Error("failed"));
    retryServerConfigSync();
    expect(h.stops[0]).toHaveBeenCalledOnce();
    expect(h.client.subscribeConfig).toHaveBeenCalledTimes(2);
    expect(h.client.getConfig).toHaveBeenCalledOnce();
    oldListener({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfig()).toBeNull();
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfig()).toEqual(serverConfigFixture);
  });

  it("ignores callbacks and retry actions after synchronization is stopped", () => {
    const h = harness();
    const stop = startServerStateSync(h.client);
    stop();
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    retryServerConfigSync();
    expect(getServerConfig()).toBeNull();
    expect(h.client.subscribeConfig).toHaveBeenCalledOnce();
  });

  it("fences an old fallback during explicit retry without concurrent fallback fetch owners", async () => {
    const h = harness();
    let resolve!: (config: typeof serverConfigFixture) => void;
    h.client.getConfig.mockReturnValueOnce(
      new Promise((next) => {
        resolve = next;
      }),
    );
    cleanups.push(startServerStateSync(h.client));
    retryServerConfigSync();
    expect(h.client.getConfig).toHaveBeenCalledOnce();
    resolve({ ...serverConfigFixture, cwd: "/stale-fallback" });
    await vi.waitFor(() => expect(h.client.getConfig).toHaveBeenCalledTimes(2));
    expect(getServerConfig()).toBeNull();
    h.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfig()).toEqual(serverConfigFixture);
  });

  it("fences a previous synchronization generation while preserving loaded config", () => {
    const first = harness();
    const second = harness();
    cleanups.push(startServerStateSync(first.client), startServerStateSync(second.client));
    first.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    expect(getServerConfig()).toBeNull();
    second.event({ version: 1, type: "snapshot", config: serverConfigFixture });
    first.policy().shouldRetry?.(new Error("old failure"));
    expect(getServerConfigReadiness().stream).toBe("live");
    expect(getServerConfig()).toEqual(serverConfigFixture);
  });
});
