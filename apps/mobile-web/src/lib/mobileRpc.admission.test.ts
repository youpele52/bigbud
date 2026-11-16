import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import { createMobileRpcReconnectPolicy } from "./mobileRpc.protocol";
import { verifyMobileHostConnection, type MobileHostEntry } from "./mobileHostConnection";

const descriptor: RemoteBackendMobileDescriptor = {
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "fixture",
  mobileRpcRevision: 1,
  mobileCapable: true,
};
const host: MobileHostEntry = {
  pin: descriptor,
  backendOrigin: "https://fixture.invalid",
  session: {
    backendBaseUrl: "https://fixture.invalid",
    sessionId: "fixture-session",
    sessionToken: "fixture-token",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const url = "wss://fixture.invalid/mobile-ws?token=fixture-token";
beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://fixture.invalid" } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("actual socket acquisition admission", () => {
  it("never dials or even preflights foreign credentials from a host-served origin", async () => {
    vi.stubGlobal("window", { location: { origin: "https://host-a.invalid" } });
    const construct = vi.fn();
    vi.stubGlobal("WebSocket", construct);
    const fetcher = vi.fn<typeof fetch>();
    const policy = createMobileRpcReconnectPolicy({
      beforeConnect: async (signal) => {
        await verifyMobileHostConnection(host, { signal, fetch: fetcher });
      },
    });
    await expect(Effect.runPromise(policy.acquireSocket(url))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
  });

  it("rechecks identity before every socket and never forwards credentials to a replacement authority", async () => {
    const construct = vi.fn(function () {
      return new EventTarget();
    });
    vi.stubGlobal("WebSocket", construct);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(descriptor)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...descriptor,
            authority: { ...descriptor.authority, authorityId: "d".repeat(32) },
          }),
        ),
      );
    const onIdentityRejected = vi.fn();
    const policy = createMobileRpcReconnectPolicy({
      beforeConnect: async (signal) => {
        await verifyMobileHostConnection(host, { signal, fetch: fetcher });
      },
      onIdentityRejected,
    });
    await Effect.runPromise(policy.acquireSocket(url));
    expect(construct).toHaveBeenCalledExactlyOnceWith(url, undefined);
    await expect(Effect.runPromise(policy.acquireSocket(url))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(construct).toHaveBeenCalledOnce();
    expect(onIdentityRejected).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("different backend"),
    );
    // The actual shared retry policy terminates on identity refusal; no retry timer/credential dial.
    await Effect.runPromise(
      Effect.fail("probe").pipe(Effect.retry(policy.retryPolicy), Effect.ignore),
    );
    expect(construct).toHaveBeenCalledOnce();
  });

  it.each(["mobile-unavailable", "unsupported-revision", "legacy"])(
    "refuses %s before constructing any credential-bearing socket",
    async (kind) => {
      const construct = vi.fn();
      vi.stubGlobal("WebSocket", construct);
      const response =
        kind === "legacy"
          ? new Response(null, { status: 404 })
          : new Response(
              JSON.stringify({
                ...descriptor,
                ...(kind === "mobile-unavailable"
                  ? { mobileCapable: false }
                  : { mobileRpcRevision: 999 }),
              }),
            );
      const policy = createMobileRpcReconnectPolicy({
        beforeConnect: async (signal) => {
          await verifyMobileHostConnection(host, {
            signal,
            fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
          });
        },
      });
      await expect(Effect.runPromise(policy.acquireSocket(url))).rejects.toThrow();
      expect(construct).not.toHaveBeenCalled();
    },
  );

  it("interrupts an old held preflight without opening a socket or treating owner cancellation as identity rejection", async () => {
    const construct = vi.fn();
    vi.stubGlobal("WebSocket", construct);
    let signal: AbortSignal | undefined;
    const beforeConnect = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<void>((_, reject) =>
        value.addEventListener("abort", () => reject(value.reason), { once: true }),
      );
    });
    const onIdentityRejected = vi.fn();
    const policy = createMobileRpcReconnectPolicy({ beforeConnect, onIdentityRejected });
    const controller = new AbortController();
    const pending = Effect.runPromise(policy.acquireSocket(url), { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(beforeConnect).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(construct).not.toHaveBeenCalled();
    expect(onIdentityRejected).not.toHaveBeenCalled();
  });

  it("checks expiry and original credential origin before making even the public request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      verifyMobileHostConnection(
        { ...host, session: { ...host.session, expiresAt: "2000-01-01T00:00:00Z" } },
        { fetch: fetcher },
      ),
    ).rejects.toThrow("expired");
    await expect(
      verifyMobileHostConnection(
        { ...host, session: { ...host.session, backendBaseUrl: "https://other.invalid" } },
        { fetch: fetcher },
      ),
    ).rejects.toThrow("does not belong");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
