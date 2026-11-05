import { createHash, timingSafeEqual } from "node:crypto";
import { open, rm } from "node:fs/promises";

import type { CopilotRuntimeRelease } from "./Runtime.release.ts";

export type CopilotRuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CopilotRuntimeProgress {
  readonly phase: "downloading" | "verifying" | "installing" | "installed";
  readonly transferredBytes: number;
  readonly totalBytes: number;
}

/** Streams one pinned archive to a private staging file; no redirects or runtime metadata trust. */
export async function downloadCopilotRuntime(input: {
  readonly release: CopilotRuntimeRelease;
  readonly destination: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CopilotRuntimeProgress) => void;
  readonly fetch?: CopilotRuntimeFetch;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { release } = input;
  const url = new URL(release.url);
  if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.hash) {
    throw new Error("Copilot runtime download requires the official HTTPS registry.");
  }
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(input.timeoutMs ?? 15 * 60_000),
  ]);
  signal.throwIfAborted();
  const file = await open(input.destination, "wx", 0o600);
  let complete = false;
  try {
    const response = await (input.fetch ?? fetch)(url, { signal, redirect: "error" });
    const declared = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      !response.body ||
      (declared !== null && Number(declared) !== release.archiveBytes) ||
      (response.headers.get("content-encoding") ?? "identity") !== "identity"
    ) {
      await response.body?.cancel();
      throw new Error(`Invalid Copilot archive response (HTTP ${response.status}).`);
    }
    const hash = createHash("sha512");
    let transferredBytes = 0;
    input.onProgress?.({
      phase: "downloading",
      transferredBytes,
      totalBytes: release.archiveBytes,
    });
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      transferredBytes += chunk.byteLength;
      if (transferredBytes > release.archiveBytes)
        throw new Error("Copilot archive exceeds pinned size.");
      hash.update(chunk);
      await file.writeFile(chunk);
      input.onProgress?.({
        phase: "downloading",
        transferredBytes,
        totalBytes: release.archiveBytes,
      });
    }
    signal.throwIfAborted();
    if (transferredBytes !== release.archiveBytes) throw new Error("Copilot archive is truncated.");
    input.onProgress?.({ phase: "verifying", transferredBytes, totalBytes: release.archiveBytes });
    const expected = Buffer.from(release.integrity.replace(/^sha512-/, ""), "base64");
    const actual = hash.digest();
    if (
      !release.integrity.startsWith("sha512-") ||
      expected.length !== actual.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Copilot runtime checksum mismatch.");
    }
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await rm(input.destination, { force: true });
  }
}
