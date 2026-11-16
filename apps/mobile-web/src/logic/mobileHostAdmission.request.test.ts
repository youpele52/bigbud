import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMobileHostDescriptor } from "./mobileHostAdmission";
import { MOBILE_HOST_IDENTITY_TIMEOUT_MS } from "./mobileHostAdmission.request";

const origin = "https://fixture.invalid";
afterEach(() => vi.useRealTimers());

describe("bounded mobile descriptor requests", () => {
  it("owns a total deadline when response headers remain held and fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = fetchMobileHostDescriptor(origin, { fetch: fetcher });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MOBILE_HOST_IDENTITY_TIMEOUT_MS);
    await rejected;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a held stream without awaiting a cancellation that never finishes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"handshakeRevision":'));
      },
      cancel,
    });
    const pending = fetchMobileHostDescriptor(origin, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MOBILE_HOST_IDENTITY_TIMEOUT_MS);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation during a held response and removes its listener/timer", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = fetchMobileHostDescriptor(origin, { fetch: fetcher, signal: parent.signal });
    const rejected = expect(pending).rejects.toThrow("fixture canceled");
    parent.abort(new Error("fixture canceled"));
    await rejected;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends a request for an already canceled caller", async () => {
    const parent = new AbortController();
    parent.abort(new Error("already canceled"));
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      fetchMobileHostDescriptor(origin, { fetch: fetcher, signal: parent.signal }),
    ).rejects.toThrow("already canceled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([404, 503, 302])(
    "releases early status %s without waiting for held cancellation",
    async (status) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      const pending = fetchMobileHostDescriptor(origin, { fetch: fetcher });
      if (status === 404) expect(await pending).toEqual({ status: "legacy" });
      else await expect(pending).rejects.toThrow("Could not verify");
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it("cancels a late response body from a custom fetch that ignored the deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = fetchMobileHostDescriptor(origin, { fetch: fetcher });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MOBILE_HOST_IDENTITY_TIMEOUT_MS);
    await rejected;
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
