import { describe, expect, it, vi } from "vitest";

import { makeRemoteAgentInstallSourceLoader } from "./remoteAgentInstallSource.ts";

function sourceJson(version = "1.2.3") {
  return JSON.stringify({
    manifest: {
      schemaVersion: 1,
      artifacts: [
        {
          version,
          buildDigest: `build-${version}`,
          protocolMajor: 1,
          protocolMinor: 0,
          targetTriple: "x86_64-unknown-linux-gnu",
          sizeBytes: 2,
          sha256: "a".repeat(64),
          signature: { algorithm: "ed25519", keyId: "release", value: "signature" },
          url: "https://github.com/owner/repository/releases/download/v1/agent",
        },
      ],
    },
    trustStore: { release: "public-key" },
  });
}

const environment = {
  BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL: "http://127.0.0.1/source",
};

function loader(fetch: typeof globalThis.fetch) {
  return makeRemoteAgentInstallSourceLoader(environment, {
    allowLoopbackHttp: true,
    fetch,
    logger: () => undefined,
    sleep: async () => undefined,
    random: () => 0.5,
  });
}

describe("process-scoped remote agent install source loader", () => {
  it("reuses a health load for installation", async () => {
    const request = vi.fn(async () => new Response(sourceJson()));
    const load = loader(request as unknown as typeof fetch);

    const healthSource = await load();
    const installSource = await load();

    expect(installSource).toBe(healthSource);
    expect(request).toHaveBeenCalledOnce();
  });

  it("refreshes the process cache only when explicitly requested", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(sourceJson("1.2.3")))
      .mockResolvedValueOnce(new Response(sourceJson("1.2.4")));
    const load = loader(request as unknown as typeof fetch);

    await expect(load()).resolves.toMatchObject({
      manifest: { artifacts: [{ version: "1.2.3" }] },
    });
    await expect(load()).resolves.toMatchObject({
      manifest: { artifacts: [{ version: "1.2.3" }] },
    });
    await expect(load.refresh()).resolves.toMatchObject({
      manifest: { artifacts: [{ version: "1.2.4" }] },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent loads", async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((complete) => {
          resolve = complete;
        }),
    );
    const load = loader(request as unknown as typeof fetch);
    const first = load();
    const second = load();
    resolve(new Response(sourceJson()));

    const [firstSource, secondSource] = await Promise.all([first, second]);
    expect(secondSource).toBe(firstSource);
    expect(request).toHaveBeenCalledOnce();
  });

  it("evicts a failed load", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(sourceJson()));
    const load = loader(request as unknown as typeof fetch);

    await expect(load()).rejects.toThrow("HTTP 404");
    await expect(load()).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("isolates a canceled waiter from another waiter", async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((complete) => {
          resolve = complete;
        }),
    );
    const load = loader(request as unknown as typeof fetch);
    const controller = new AbortController();
    const canceled = load(controller.signal);
    const survivor = load();
    controller.abort(new DOMException("cancelled", "AbortError"));
    resolve(new Response(sourceJson()));

    await expect(canceled).rejects.toThrow("cancelled");
    await expect(survivor).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels the shared request after its only waiter is canceled", async () => {
    const request = vi
      .fn()
      .mockImplementationOnce((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      })
      .mockResolvedValueOnce(new Response(sourceJson()));
    const load = loader(request as unknown as typeof fetch);
    const controller = new AbortController();
    const pending = load(controller.signal);

    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toThrow("cancelled");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
    await expect(load()).resolves.toMatchObject({ manifest: { schemaVersion: 1 } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not start a load for an already canceled waiter", async () => {
    const request = vi.fn(async () => new Response(sourceJson()));
    const load = loader(request as unknown as typeof fetch);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(load(controller.signal)).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});
