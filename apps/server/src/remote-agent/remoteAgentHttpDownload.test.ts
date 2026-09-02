import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadRemoteAgentHttp, RemoteAgentDownloadError } from "./remoteAgentHttpDownload.ts";
import { type RemoteAgentDownloadPolicy } from "./remoteAgentHttpDownload.policy.ts";

const policy: RemoteAgentDownloadPolicy = {
  kind: "metadata",
  maxAttempts: 3,
  attemptTimeoutMs: 20,
  overallTimeoutMs: 100,
  maxBytes: 16,
  baseRetryDelayMs: 1,
  maxRetryDelayMs: 10,
  maxRedirects: 5,
};
const fixtureUrl = "http://127.0.0.1/source";
const quiet = () => undefined;

function options(fetch: typeof globalThis.fetch) {
  return {
    fetch,
    random: () => 0.5,
    logger: quiet,
    sleep: async () => undefined,
  };
}

function fixtureInput(overrides: Partial<Parameters<typeof downloadRemoteAgentHttp>[0]> = {}) {
  return {
    url: fixtureUrl,
    policy,
    urlPolicy: { allowLoopbackHttp: true },
    ...overrides,
  };
}

function abortingFetch(): typeof fetch {
  return vi.fn((_url, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("remote agent HTTP download", () => {
  it("retries a slow header attempt and then succeeds", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockImplementationOnce((_url, init) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      })
      .mockResolvedValueOnce(new Response("ok"));

    const result = downloadRemoteAgentHttp(
      fixtureInput(),
      options(request as unknown as typeof fetch),
    );
    await vi.advanceTimersByTimeAsync(21);

    await expect(result).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries a slow body attempt and restarts the whole request", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockImplementationOnce((_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("p"));
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(new Response("ok"));

    const result = downloadRemoteAgentHttp(
      fixtureInput(),
      options(request as unknown as typeof fetch),
    );
    await vi.advanceTimersByTimeAsync(21);

    await expect(result).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("restarts from the initial URL when a redirected request times out", async () => {
    vi.useFakeTimers();
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/asset" },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      })
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/asset" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));

    const result = downloadRemoteAgentHttp(
      fixtureInput(),
      options(request as unknown as typeof fetch),
    );
    await vi.advanceTimersByTimeAsync(21);

    await expect(result).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      fixtureUrl,
      "http://127.0.0.1/asset",
      fixtureUrl,
      "http://127.0.0.1/asset",
    ]);
  });

  it("reports attempt timeout after exhausting retries", async () => {
    vi.useFakeTimers();
    const request = abortingFetch();
    const result = downloadRemoteAgentHttp(fixtureInput(), options(request));
    const rejected = expect(result).rejects.toMatchObject({
      details: { abortOwner: "attempt-timeout", attempts: 3 },
    });
    await vi.advanceTimersByTimeAsync(61);

    await rejected;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry caller cancellation", async () => {
    const controller = new AbortController();
    const request = abortingFetch();
    const result = downloadRemoteAgentHttp(
      fixtureInput({ signal: controller.signal }),
      options(request),
    );
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(result).rejects.toMatchObject({
      details: { abortOwner: "caller", attempts: 1 },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["shutdown", "shutdownSignal"],
    ["caller", "signal"],
  ] as const)("distinguishes %s cancellation", async (owner, field) => {
    const controller = new AbortController();
    const request = abortingFetch();
    const result = downloadRemoteAgentHttp(
      fixtureInput({ [field]: controller.signal }),
      options(request),
    );
    controller.abort();

    await expect(result).rejects.toMatchObject({ details: { abortOwner: owner } });
  });

  it("distinguishes an overall timeout from an attempt timeout", async () => {
    vi.useFakeTimers();
    const result = downloadRemoteAgentHttp(
      fixtureInput({ policy: { ...policy, attemptTimeoutMs: 100, overallTimeoutMs: 10 } }),
      options(abortingFetch()),
    );
    const rejected = expect(result).rejects.toMatchObject({
      details: { abortOwner: "overall-timeout", attempts: 1 },
    });
    await vi.advanceTimersByTimeAsync(11);

    await rejected;
  });

  it.each([
    [404, 1],
    [400, 1],
    [401, 1],
    [403, 1],
    [410, 1],
    [422, 1],
    [408, 3],
    [425, 3],
    [429, 3],
    [500, 3],
    [502, 3],
    [503, 3],
    [504, 3],
  ])("applies the retry policy for HTTP %i", async (status, attempts) => {
    const request = vi.fn(async () => new Response(null, { status }));

    await expect(
      downloadRemoteAgentHttp(fixtureInput(), options(request as unknown as typeof fetch)),
    ).rejects.toBeInstanceOf(RemoteAgentDownloadError);
    expect(request).toHaveBeenCalledTimes(attempts);
  });

  it("honors bounded Retry-After for HTTP 429", async () => {
    const delays: number[] = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "99" } }))
      .mockResolvedValueOnce(new Response("ok"));

    await downloadRemoteAgentHttp(fixtureInput(), {
      ...options(request as unknown as typeof fetch),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(delays).toEqual([policy.maxRetryDelayMs]);
  });

  it("emits privacy-safe terminal diagnostics", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const request = vi.fn(async () => new Response("partial", { status: 503 }));
    const secretUrl = "https://fixtures.example/private/path?token=secret#fragment";

    const result = downloadRemoteAgentHttp(
      {
        url: secretUrl,
        policy,
        urlPolicy: { allowedOrigins: new Set(["https://fixtures.example"]) },
        operationId: "correlation-1",
      },
      {
        ...options(request as unknown as typeof fetch),
        logger: (_message, details) => diagnostics.push(details),
      },
    );

    await expect(result).rejects.toThrow("metadata download failed at headers");
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("fragment");
    expect(diagnostics.at(-1)).toMatchObject({
      correlationId: "correlation-1",
      kind: "metadata",
      attempt: 3,
      hostname: "fixtures.example",
      stage: "headers",
      status: 503,
      retryDecision: "stop",
    });
  });

  it("follows a delayed approved redirect without exposing its signed query", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/asset?signature=secret" },
        });
      })
      .mockResolvedValueOnce(new Response("ok"));

    await downloadRemoteAgentHttp(fixtureInput(), {
      ...options(request as unknown as typeof fetch),
      logger: (_message, details) => diagnostics.push(details),
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    expect(diagnostics.at(-1)).toMatchObject({ redirectCount: 1, hostname: "127.0.0.1" });
  });

  it.each([
    ["redirect loop", "http://127.0.0.1/source"],
    ["HTTPS downgrade", "http://example.com/asset"],
    ["unapproved host", "https://example.com/asset"],
    ["credential URL", "https://user:secret@github.com/asset"],
  ])("rejects %s", async (_label, location) => {
    const request = vi.fn(async () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location } })),
    );

    await expect(
      downloadRemoteAgentHttp(fixtureInput(), options(request as unknown as typeof fetch)),
    ).rejects.toMatchObject({ details: { stage: "redirect", attempts: 1 } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an excessive redirect chain", async () => {
    let redirect = 0;
    const request = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1/${(redirect += 1)}` },
        }),
      ),
    );

    await expect(
      downloadRemoteAgentHttp(fixtureInput(), options(request as unknown as typeof fetch)),
    ).rejects.toMatchObject({ details: { stage: "redirect" } });
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("restricts explicit overrides to same-origin redirects", async () => {
    const request = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://github.com/owner/repository" },
        }),
      ),
    );

    await expect(
      downloadRemoteAgentHttp(
        {
          url: "https://fixtures.example/source",
          policy,
          urlPolicy: { allowedOrigins: new Set(["https://fixtures.example"]) },
        },
        options(request as unknown as typeof fetch),
      ),
    ).rejects.toMatchObject({ details: { stage: "redirect", attempts: 1 } });
  });

  it.each([
    ["empty", new Response("")],
    ["oversized header", new Response("x", { headers: { "content-length": "17" } })],
    ["oversized body", new Response("x".repeat(17))],
  ])("rejects %s metadata without retry", async (_label, response) => {
    const request = vi.fn(async () => response);
    await expect(
      downloadRemoteAgentHttp(fixtureInput(), options(request as unknown as typeof fetch)),
    ).rejects.toMatchObject({ details: { attempts: 1 } });
    expect(request).toHaveBeenCalledOnce();
  });
});
