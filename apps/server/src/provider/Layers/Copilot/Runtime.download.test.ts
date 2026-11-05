import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadCopilotRuntime, type CopilotRuntimeFetch } from "./Runtime.download.ts";
import { archiveFetch, runtimeFixture } from "./Runtime.test.helpers.ts";

const roots: string[] = [];
const stalledFetch: CopilotRuntimeFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(Path.join(tmpdir(), "bigbud-copilot-download-"));
  roots.push(root);
  return { root, destination: Path.join(root, "runtime.tgz") };
}

describe("Copilot archive download", () => {
  it("streams a verified download with determinate pinned archive length even without Content-Length", async () => {
    const { destination } = await storage();
    const fixture = runtimeFixture();
    const onProgress = vi.fn();
    const fetch = vi.fn(archiveFetch(fixture.bytes));
    await downloadCopilotRuntime({ destination, release: fixture.release, fetch, onProgress });
    expect(await readFile(destination)).toEqual(fixture.bytes);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(onProgress.mock.lastCall?.[0]).toEqual({
      phase: "verifying",
      transferredBytes: fixture.bytes.length,
      totalBytes: fixture.bytes.length,
    });
  });

  it.each(["truncated", "oversized", "length", "status", "encoding", "network"])(
    "cleans up %s failures",
    async (kind) => {
      const { root, destination } = await storage();
      const fixture = runtimeFixture();
      const bytes =
        kind === "truncated"
          ? fixture.bytes.subarray(1)
          : kind === "oversized"
            ? Buffer.concat([fixture.bytes, Buffer.from("x")])
            : fixture.bytes;
      const fetch: CopilotRuntimeFetch = async () => {
        if (kind === "network") throw new Error("network down");
        return new Response(bytes, {
          status: kind === "status" ? 503 : 200,
          headers:
            kind === "length"
              ? { "content-length": "1" }
              : kind === "encoding"
                ? { "content-encoding": "gzip" }
                : {},
        });
      };
      await expect(
        downloadCopilotRuntime({ destination, release: fixture.release, fetch }),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("rejects untrusted download origins before touching storage", async () => {
    const { root, destination } = await storage();
    const fixture = runtimeFixture();
    await expect(
      downloadCopilotRuntime({
        destination,
        release: { ...fixture.release, url: "https://evil.example/runtime" },
      }),
    ).rejects.toThrow("official HTTPS registry");
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels mid-download and removes the partial file", async () => {
    const { root, destination } = await storage();
    const fixture = runtimeFixture();
    const controller = new AbortController();
    await expect(
      downloadCopilotRuntime({
        destination,
        release: fixture.release,
        signal: controller.signal,
        fetch: archiveFetch(fixture.bytes),
        onProgress: (progress) => {
          if (progress.transferredBytes > 0) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("bounds stalled requests with a timeout and cleans up", async () => {
    const { root, destination } = await storage();
    const fixture = runtimeFixture();
    await expect(
      downloadCopilotRuntime({
        destination,
        release: fixture.release,
        fetch: stalledFetch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
