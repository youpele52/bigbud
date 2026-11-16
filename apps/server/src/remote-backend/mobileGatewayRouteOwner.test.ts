import { afterEach, expect, it, vi } from "vitest";
import type { MobileGatewayRouteInput } from "./mobileGatewayOwner.route.ts";
import {
  assertMobileGatewayServeRoute,
  makeMobileGatewayRouteOwner,
} from "./mobileGatewayRouteOwner.ts";

const input = (): MobileGatewayRouteInput => ({
  externalOrigin: "https://fixture.example.ts.net",
  port: 31999,
  expected: {
    handshakeRevision: 1,
    authority: {
      authorityId: "a".repeat(32),
      keyEpoch: 1,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    backendVersion: "1.0.0",
    mobileRpcRevision: 1,
    mobileCapable: false,
  },
});
const status = () => ({
  BackendState: "Running",
  Self: { Online: true, DNSName: "fixture.example.ts.net." },
});
const config = () => ({
  TCP: { "443": { HTTPS: true } },
  Web: { "fixture.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:31999" } } } },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("requires the exact hostname and loopback target while preserving unrelated routes", () => {
  const value = config();
  Object.assign(value.Web["fixture.example.ts.net:443"].Handlers, {
    "/other": { Text: "foreign" },
  });
  expect(() => assertMobileGatewayServeRoute(input(), status(), value)).not.toThrow();
  expect(() =>
    assertMobileGatewayServeRoute(
      { ...input(), externalOrigin: "https://fixture.example.ts.net:8443" },
      status(),
      value,
    ),
  ).toThrow();
  for (const altered of [
    { ...status(), BackendState: "Stopped" },
    { ...status(), Self: { Online: false, DNSName: "fixture.example.ts.net" } },
    { ...status(), Self: { Online: true, DNSName: "other.example.ts.net" } },
  ])
    expect(() => assertMobileGatewayServeRoute(input(), altered, value)).toThrow();
  for (const proxy of [
    "http://127.0.0.1:31998",
    "http://127.0.0.1:31999/path",
    "http://localhost:31999",
    "http://user@127.0.0.1:31999",
  ])
    expect(() =>
      assertMobileGatewayServeRoute(input(), status(), {
        ...value,
        Web: { "fixture.example.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
      }),
    ).toThrow();
  expect(() =>
    assertMobileGatewayServeRoute(input(), status(), {
      ...value,
      Web: { "other.example.ts.net:443": value.Web["fixture.example.ts.net:443"] },
    }),
  ).toThrow();
});

it("refuses public Funnel, missing TLS, or more-specific mobile route replacement", () => {
  for (const AllowFunnel of [true, { "fixture.example.ts.net:443": true }, { other: "false" }])
    expect(() =>
      assertMobileGatewayServeRoute(input(), status(), { ...config(), AllowFunnel }),
    ).toThrow();
  expect(() =>
    assertMobileGatewayServeRoute(input(), status(), { ...config(), TCP: {} }),
  ).toThrow();
  for (const path of ["/mobile", "/mobile/asset.js", "/mobile-ws", "/api", "/api/mobile/handshake"])
    expect(() =>
      assertMobileGatewayServeRoute(input(), status(), {
        ...config(),
        Web: {
          "fixture.example.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:31999" },
              [path]: { Text: "foreign" },
            },
          },
        },
      }),
    ).toThrow();
});

it("publishes only after final verification, cheaply checks the original lease and retires it", async () => {
  const verify = vi.fn(async () => {});
  const owner = makeMobileGatewayRouteOwner(verify);
  let retained: Parameters<Parameters<typeof owner.withRoute>[1]>[0] | undefined;
  const result = await owner.withRoute(
    input(),
    async (route, signal) => {
      expect(verify).toHaveBeenCalledTimes(2);
      retained = route;
      for (let i = 0; i < 20; i++) await route.assertCurrent(signal);
      expect(verify).toHaveBeenCalledTimes(2);
      return "complete";
    },
    new AbortController().signal,
  );
  expect(result).toBe("complete");
  await expect(retained!.assertCurrent(new AbortController().signal)).rejects.toThrow();
});

it("aborts admission on route loss and settles callback cleanup before returning", async () => {
  let count = 0;
  const owner = makeMobileGatewayRouteOwner(async () => {
    if (++count === 3) throw new Error("lost");
  });
  let cleaned = false;
  let observedLoss!: () => void;
  const lost = new Promise<void>((resolve) => {
    observedLoss = resolve;
  });
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const pending = owner.withRoute(
    input(),
    async (_route, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      observedLoss();
      await cleanup;
      cleaned = true;
    },
    new AbortController().signal,
  );
  const rejection = expect(pending).rejects.toThrow();
  await lost;
  expect(cleaned).toBe(false);
  releaseCleanup();
  await rejection;
  expect(cleaned).toBe(true);
});

it("refuses an expired observation after an event-loop stall or clock regression", async () => {
  const now = 10_000;
  let monotonic = now;
  let wall = now;
  const owner = makeMobileGatewayRouteOwner(async () => {}, {
    monotonic: () => monotonic,
    wall: () => wall,
  });
  for (const delta of [5001, -1]) {
    monotonic = now;
    wall = now;
    await expect(
      owner.withRoute(
        input(),
        async (route, signal) => {
          // A rollback leaves a positive wall age, which the old wall-only check accepted.
          wall = now + 1000;
          monotonic = now + delta;
          await route.assertCurrent(signal);
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  monotonic = now;
  wall = now;
  await expect(
    owner.withRoute(
      input(),
      async (route, signal) => {
        // A suspended platform can pause monotonic time: forward wall age still fences it.
        wall += 5001;
        await route.assertCurrent(signal);
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
