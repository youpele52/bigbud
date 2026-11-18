import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exchangeMobilePairing,
  normalizePairingBackendOrigin,
  readMobilePairingStatus,
} from "./MobilePair.request";
import { mobilePairingSecret } from "./MobilePair.logic";

const origin = "https://fixture.invalid";
const status = {
  pairingId: "fixture",
  scope: "read-only",
  expiresAt: "2027-01-01T00:00:00Z",
  enabled: true,
  available: true,
};
const session = {
  sessionId: "fixture-session",
  sessionToken: "fixture-token",
  websocketUrl: "wss://wrong.invalid",
  scope: "read-only",
  expiresAt: status.expiresAt,
};
beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://fixture.invalid" } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("origin-bound pairing requests", () => {
  it("sends a secret once to the exact selected origin, blocks redirects/cookies/referrers and decodes only known response fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ...session, unexpected: "ignored" })));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await exchangeMobilePairing(origin, "fixture/id", {
        secret: "fixture-secret",
        label: "fixture",
      }),
    ).toEqual(session);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${origin}/api/mobile/pairing/fixture%2Fid/exchange`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        body: JSON.stringify({ secret: "fixture-secret", label: "fixture" }),
      }),
    );
  });

  it("makes no foreign credential request from a host-served app, but permits the exact hosted compatibility origin", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", { location: { origin: "https://host-a.invalid" } });
    await expect(
      exchangeMobilePairing(origin, "fixture", { secret: "fixture-secret", label: "fixture" }),
    ).rejects.toThrow("own mobile app");
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubGlobal("window", { location: { origin: "https://mobile.bigbud.app" } });
    await expect(
      exchangeMobilePairing(origin, "fixture", { secret: "fixture-secret", label: "fixture" }),
    ).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin/redirected response without retrying or activating its credential", async () => {
    const response = new Response(JSON.stringify(session));
    Object.defineProperty(response, "url", { value: "https://other.invalid/exchange" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    await expect(
      exchangeMobilePairing(origin, "fixture", { secret: "fixture-secret", label: "fixture" }),
    ).rejects.toThrow("redirect");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed/sensitive responses without echoing their payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ privateValue: "fixture-sensitive" }))),
    );
    await expect(readMobilePairingStatus(origin, "fixture")).rejects.toThrow(
      "invalid pairing status",
    );
  });

  it("bounds a held pairing response body even when cancel never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    const pending = readMobilePairingStatus(origin, "fixture");
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains typed unavailable/expired status as an HTTP refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 })),
    );
    await expect(readMobilePairingStatus(origin, "fixture")).rejects.toMatchObject({ status: 410 });
  });

  it("rejects unsafe origins before sending any request and permits legacy HTTP/LAN only explicitly", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    expect(normalizePairingBackendOrigin(`${origin}/path`, true)).toBe("");
    expect(normalizePairingBackendOrigin("https://user:password@fixture.invalid", true)).toBe("");
    expect(normalizePairingBackendOrigin("http://127.0.0.1:1234", false)).toBe("");
    expect(normalizePairingBackendOrigin("http://192.168.1.10:3000", true)).toBe(
      "http://192.168.1.10:3000",
    );
    expect(normalizePairingBackendOrigin("http://127.0.0.1:1234", true)).toBe(
      "http://127.0.0.1:1234",
    );
    await expect(
      readMobilePairingStatus("https://user:password@fixture.invalid", "fixture"),
    ).rejects.toThrow("exact authorized");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps pairing fragments out of public status requests and handles malformed fragments safely", async () => {
    expect(mobilePairingSecret(`${origin}/mobile/pair/fixture#secret=fixture%20secret`)).toBe(
      "fixture secret",
    );
    expect(mobilePairingSecret(`${origin}/mobile/pair/fixture#secret=%XX`)).toBe("");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(status)));
    vi.stubGlobal("fetch", fetcher);
    expect(await readMobilePairingStatus(origin, "fixture")).toEqual(status);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${origin}/api/mobile/pairing/fixture`);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
