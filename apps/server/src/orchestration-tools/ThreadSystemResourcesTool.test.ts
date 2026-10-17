import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { getSystemResources, setSystemMonitorAgentAccess } from "./ThreadSystemResourcesTool.ts";

afterEach(() => {
  setSystemMonitorAgentAccess(undefined);
  vi.unstubAllGlobals();
});

it("returns unavailable without a desktop endpoint", async () => {
  expect(await Effect.runPromise(getSystemResources())).toEqual({
    available: false,
    reason: "desktop monitor unavailable",
  });
});

it("accepts a fresh bounded desktop snapshot", async () => {
  setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "secret" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          sampledAtMs: Date.now(),
          host: { hostname: "desktop", osName: "Darwin", osVersion: "26", architecture: "arm64" },
          epoch: 1,
          sequence: 2,
          summaryStatus: "ready",
          secretPath: "/private/user/path",
        }),
      ),
    ),
  );
  const result = await Effect.runPromise(getSystemResources());
  expect(result.available).toBe(true);
  if (result.available) {
    expect(result.cpuPercent).toEqual({
      value: null,
      status: "unavailable",
      sampledAtMs: result.sampledAtMs,
    });
  }
  expect(JSON.stringify(result)).not.toContain("secretPath");
});

it("does not report stale data as a current observation", async () => {
  setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "secret" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          sampledAtMs: Date.now() - 30_000,
          host: { hostname: "desktop", osName: "Darwin", osVersion: "26", architecture: "arm64" },
          epoch: 1,
          sequence: 2,
          summaryStatus: "ready",
        }),
      ),
    ),
  );
  expect(await Effect.runPromise(getSystemResources())).toEqual({
    available: false,
    reason: "desktop monitor unavailable",
  });
});
