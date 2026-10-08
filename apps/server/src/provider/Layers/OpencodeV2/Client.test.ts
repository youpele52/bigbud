import { describe, expect, it, vi } from "vitest";

import { makeOwnedClient, v2Request } from "./Client.ts";
import { assertDevelopmentVersion, validateOwnedEndpoint } from "./Compatibility.ts";
import { V2_DEVELOPMENT_RESPONSE_BYTES, V2ResponseSizeError } from "./Client.response.ts";

describe("pinned OpenCode v2 Promise boundary", () => {
  it.each([
    "http://evil.example:4000",
    "http://127.0.0.1",
    "https://127.0.0.1:4000",
    "http://user:pass@127.0.0.1:4000",
    "http://127.0.0.1:4000/path",
    "http://127.0.0.1:4000/?secret=x",
  ])("rejects unsafe readiness %s before credentials", (url) =>
    expect(() => validateOwnedEndpoint(url)).toThrow(),
  );
  it("rejects unknown CLI versions", () => {
    expect(() => assertDevelopmentVersion("2.0.19")).not.toThrow();
    for (const version of ["1.17.13", "2.0.20", "2.0.19-preview", "opencode v2.0.19"])
      expect(() => assertDevelopmentVersion(version)).toThrow();
  });
  it("authenticates only the owned endpoint and disables redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImplementation = Object.assign(
      async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(request), init });
        return new Response(
          JSON.stringify({ version: "2.0.19", pid: 123, urls: [], paths: { tmp: "/fixture" } }),
          { headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const client = makeOwnedClient({
      endpoint: "http://127.0.0.1:4000",
      password: "synthetic-secret",
      fetch: fetchImplementation,
    });
    expect((await client.server.info()).version).toBe("2.0.19");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/api/info");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:synthetic-secret").toString("base64")}`,
    );
  });
  it("deadline settles abort-ignoring requests without exposing SDK request data", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const request = v2Request(
        "fixture",
        (value) => {
          signal = value;
          return new Promise(() => {});
        },
        { timeoutMs: 10 },
      );
      const rejected = expect(request).rejects.toThrow("admission may be unconfirmed");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(signal?.aborted).toBe(true);
      await expect(
        v2Request("fixture", async () => {
          throw new Error("synthetic-secret prompt-body");
        }),
      ).rejects.not.toThrow("synthetic-secret");
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves local byte-bound classification through real SDK wrapping without retaining request data", async () => {
    const client = makeOwnedClient({
      endpoint: "http://127.0.0.1:4000",
      password: "synthetic-secret",
      fetch: Object.assign(
        async () =>
          new Response(
            JSON.stringify({
              secret: "synthetic-secret",
              padding: "x".repeat(V2_DEVELOPMENT_RESPONSE_BYTES),
            }),
            { headers: { "content-type": "application/json" } },
          ),
        { preconnect: () => {} },
      ) as typeof fetch,
    });
    const error = await v2Request("server.info", (signal) => client.server.info({ signal })).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(V2ResponseSizeError);
    expect(error).toMatchObject({
      message: "OpenCode v2 response exceeded the decoding safety bound.",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
