import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  getSystemResources,
  configureSystemResourceRules,
  setSystemMonitorAgentAccess,
} from "./ThreadSystemResourcesTool.ts";

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

it("uses fixed nonredirecting routes, bounded context timeout and validated read/mutation arguments", async () => {
  setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "secret" });
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ available: true, preferences: { revision: 2 } })),
    );
  vi.stubGlobal("fetch", fetcher);
  const rules = await Effect.runPromise(getSystemResources({ view: "rules" }));
  expect(rules.available).toBe(true);
  expect(fetcher.mock.calls[0]?.[0].pathname).toBe("/read");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error",
    method: "POST",
    body: '{"view":"rules"}',
  });
  await Effect.runPromise(
    configureSystemResourceRules({ expectedRevision: 2, operation: "enable", enabled: false }),
  );
  expect(fetcher.mock.calls[1]?.[0].pathname).toBe("/rules");
  const invalid = await Effect.runPromise(getSystemResources({ limit: 1000 }));
  expect(invalid.available).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await Effect.runPromise(getSystemResources({}, true));
  expect(fetcher.mock.calls[2]?.[0].pathname).toBe("/context");
  expect(fetcher.mock.calls[2]?.[1].method).toBe("GET");
});

it("preserves explicit cursor/conflict errors and fences a response after access rotates", async () => {
  setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "first" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ reason: "stale_cursor" }), { status: 503 })),
  );
  expect(await Effect.runPromise(getSystemResources({ view: "processes" }))).toEqual({
    available: false,
    reason: "stale_cursor",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "second" });
      return new Response(JSON.stringify({ available: true, preferences: {} }));
    }),
  );
  expect(await Effect.runPromise(getSystemResources({ view: "rules" }))).toEqual({
    available: false,
    reason: "monitor authorization revoked",
  });
});

it("rejects oversized UTF-8 responses instead of treating them as telemetry", async () => {
  setSystemMonitorAgentAccess({ endpoint: "http://127.0.0.1:1234/snapshot", token: "secret" });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ available: true, padding: "🔥".repeat(9000) })),
    ),
  );
  expect(await Effect.runPromise(getSystemResources())).toEqual({
    available: false,
    reason: "monitor response too large",
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
