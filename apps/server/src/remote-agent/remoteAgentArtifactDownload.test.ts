import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";

const artifact = {
  version: "1.2.3",
  buildDigest: "build-1.2.3",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: 2,
  sha256: "a".repeat(64),
  signature: { algorithm: "ed25519" as const, keyId: "release", value: "signature" },
  url: "http://127.0.0.1/agent",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("remote agent artifact download", () => {
  it("enforces the signed expected size without retrying", async () => {
    const request = vi.fn(async () => new Response("bad"));

    await expect(
      downloadRemoteAgentArtifact(artifact, {
        allowLoopbackHttp: true,
        fetch: request as unknown as typeof fetch,
        logger: () => undefined,
      }),
    ).rejects.toMatchObject({ details: { kind: "artifact", attempts: 1, stage: "body" } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("restarts the whole artifact attempt after a timeout", async () => {
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
    const result = downloadRemoteAgentArtifact(artifact, {
      allowLoopbackHttp: true,
      fetch: request as unknown as typeof fetch,
      logger: () => undefined,
      sleep: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(result).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a short artifact response", async () => {
    const request = vi.fn(async () => new Response("x"));

    await expect(
      downloadRemoteAgentArtifact(artifact, {
        allowLoopbackHttp: true,
        fetch: request as unknown as typeof fetch,
        logger: () => undefined,
      }),
    ).rejects.toThrow("artifact download failed at body");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a signed size mismatch in response headers without retrying", async () => {
    const request = vi.fn(async () => new Response("ok", { headers: { "content-length": "3" } }));

    await expect(
      downloadRemoteAgentArtifact(artifact, {
        allowLoopbackHttp: true,
        fetch: request as unknown as typeof fetch,
        logger: () => undefined,
      }),
    ).rejects.toMatchObject({ details: { attempts: 1, stage: "headers", status: 200 } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects artifacts above the 128 MiB policy before requesting them", async () => {
    const request = vi.fn();

    await expect(
      downloadRemoteAgentArtifact(
        { ...artifact, sizeBytes: 128 * 1024 * 1024 + 1 },
        { fetch: request, logger: () => undefined },
      ),
    ).rejects.toThrow("134217728 byte limit");
    expect(request).not.toHaveBeenCalled();
  });
});
