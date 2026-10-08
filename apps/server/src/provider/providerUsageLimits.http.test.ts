import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  makeHttpUsageLimitsReader,
  withHttpUsageLimits,
  type UsageCredential,
} from "./providerUsageLimits.http.ts";
import { buildServerProvider } from "./providerSnapshot.ts";
import { normalizeOpencodeGoUsageLimits } from "./Layers/Opencode/Provider.usageLimits.normalize.ts";

const quota = { usage: { rolling: { percent: 25 } } };
const signal = () => new AbortController().signal;

function fixture() {
  let credential: UsageCredential | undefined = {
    secret: "test-key-a",
    headers: { Authorization: "Bearer test-key-a" },
  };
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(quota)));
  const read = makeHttpUsageLimitsReader({
    source: "opencode-go-api",
    url: "https://opencode.ai/zen/go/v1/usage",
    loadCredential: async () => credential,
    normalize: normalizeOpencodeGoUsageLimits,
    fetch: request,
    timeoutMs: 10,
  });
  return {
    request,
    read,
    setCredential: (next: UsageCredential | undefined) => {
      credential = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded optional usage reads", () => {
  it("skips network access without credentials", async () => {
    const { request, read, setCredential } = fixture();
    setCredential(undefined);
    expect((await read(signal())).status).toBe("unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("forbids redirects and caches same-account reads", async () => {
    const { request, read } = fixture();
    expect((await read(signal())).windows[0]?.utilization).toBe(25);
    await read(signal());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer test-key-a" },
    });
  });

  it("retains quota as stale only for an unchanged credential", async () => {
    vi.useFakeTimers();
    const { request, read, setCredential } = fixture();
    const good = await read(signal());
    vi.advanceTimersByTime(60_001);
    request.mockRejectedValue(new Error("secret token must not leak"));
    expect(await read(signal())).toMatchObject({
      status: "stale",
      lastSuccessfulAt: good.checkedAt,
      windows: good.windows,
    });
    setCredential({ secret: "test-key-b", headers: { Authorization: "Bearer test-key-b" } });
    const failed = await read(signal());
    expect(failed).toMatchObject({ status: "error", windows: [] });
    expect(JSON.stringify(failed)).not.toContain("secret token");
  });

  it("forgets last-good quota after credential removal", async () => {
    const { request, read, setCredential } = fixture();
    await read(signal());
    setCredential(undefined);
    expect((await read(signal())).status).toBe("unavailable");
    setCredential({ secret: "test-key-a", headers: { Authorization: "Bearer test-key-a" } });
    request.mockRejectedValue(new Error("offline"));
    expect(await read(signal())).toMatchObject({ status: "error", windows: [] });
  });

  it.each([401, 403, 404])("hides rejected or unsupported credentials: %s", async (status) => {
    const { request, read } = fixture();
    request.mockResolvedValue(new Response("not supported", { status }));
    expect((await read(signal())).status).toBe("unavailable");
  });

  it("rejects malformed and oversized responses with safe messages", async () => {
    for (const body of ["not json", "x".repeat(256 * 1024 + 1)]) {
      const { request, read } = fixture();
      request.mockResolvedValue(new Response(body));
      expect(await read(signal())).toMatchObject({
        status: "error",
        windows: [],
        message: "Subscription limits could not be refreshed.",
      });
    }
  });

  it("propagates cancellation without caching an abandoned request", async () => {
    const { request, read } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(read(controller.signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect((await read(signal())).status).toBe("available");
  });

  it("does not retain quota returned after the request was cancelled", async () => {
    const { request, read } = fixture();
    const controller = new AbortController();
    request.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(JSON.stringify(quota));
    });
    await expect(read(controller.signal)).rejects.toThrow();
    request.mockRejectedValue(new Error("offline"));
    expect(await read(signal())).toMatchObject({ status: "error", windows: [] });
  });

  it("aborts requests that exceed their deadline", async () => {
    const { request, read } = fixture();
    request.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
            once: true,
          });
        }),
    );
    expect((await read(signal())).status).toBe("error");
  });

  it.each(["disabled", "missing", "unauthenticated"])(
    "skips credentials for %s providers",
    async (reason) => {
      const snapshot = buildServerProvider({
        provider: "cursor",
        enabled: reason !== "disabled",
        checkedAt: new Date().toISOString(),
        models: [],
        probe: {
          installed: reason !== "missing",
          version: null,
          status: "ready",
          auth: { status: reason === "unauthenticated" ? "unauthenticated" : "authenticated" },
        },
      });
      const read = vi.fn();
      expect(await Effect.runPromise(withHttpUsageLimits(snapshot, read))).toBe(snapshot);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("quota failures do not change provider availability or authentication", async () => {
    const snapshot = buildServerProvider({
      provider: "cursor",
      enabled: true,
      checkedAt: new Date().toISOString(),
      models: [],
      probe: { installed: true, version: "1", status: "ready", auth: { status: "authenticated" } },
    });
    const { read, request } = fixture();
    request.mockRejectedValue(new Error("private upstream error"));
    const result = await Effect.runPromise(withHttpUsageLimits(snapshot, read));
    expect(result).toMatchObject({
      status: "ready",
      auth: snapshot.auth,
      usageLimits: { status: "error" },
    });
    expect(JSON.stringify(result)).not.toContain("private upstream error");
  });
});
