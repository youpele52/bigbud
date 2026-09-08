import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import { captureDirectCleanupIdentity } from "./DirectResourceCleanup.identity.ts";
import { makeDirectResourceCleanupExecutor } from "./DirectResourceCleanupExecutor.ts";
import {
  buildDirectCleanupRequest,
  encodeDirectCleanupRequest,
} from "./DirectResourceCleanup.request.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DirectResourceCleanupExecutor real process", () => {
  it("removes a verified temporary resource through the built local agent", async () => {
    const extension = process.platform === "win32" ? ".exe" : "";
    const candidates = [
      fileURLToPath(
        new URL(`../../../../../target/debug/bigbud-remote-agent${extension}`, import.meta.url),
      ),
      fileURLToPath(
        new URL(`../../../../../target/release/bigbud-remote-agent${extension}`, import.meta.url),
      ),
    ];
    const binary = candidates.find(existsSync);
    if (!binary) throw new Error("Build bigbud-remote-agent before running the integration test.");
    const root = mkdtempSync(join(tmpdir(), "bigbud-cleanup-integration-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    writeFileSync(target, "content");
    const identities = await captureDirectCleanupIdentity({ root, relativePath: "target" });
    const resource = {
      resourceId: "resource",
      kind: "attachment" as const,
      root,
      relativePath: "target",
      quarantineName: ".bigbud-cleanup-integration",
      ...(identities.identity ? { identity: identities.identity } : {}),
      rootIdentity: identities.rootIdentity,
      parentIdentity: identities.parentIdentity,
    };
    const executor = await Effect.runPromise(
      makeDirectResourceCleanupExecutor(() => binary).prepare(),
    );
    try {
      const request = buildDirectCleanupRequest({
        requestId: "integration-attempt",
        operationId: "integration-operation",
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        deadlineUnixMs: Date.now() + 30_000,
        platform:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : process.platform,
        resources: [resource],
      });
      const results = await executor.execute({
        request,
        encodedRequest: encodeDirectCleanupRequest(request),
        resources: [resource],
      });
      expect(results).toEqual([{ resourceId: "resource", outcome: "removed", errorCode: "" }]);
      expect(existsSync(target)).toBe(false);
    } finally {
      executor.close();
    }
  });
});
