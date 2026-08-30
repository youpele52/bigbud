import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES } from "../../remote-agent/remoteAgentProtocol.ts";
import type { DirectCleanupResource } from "../Services/DirectResourceCleanupExecutor.ts";
import {
  buildDirectCleanupRequest,
  encodeDirectCleanupRequest,
  paginateDirectCleanupResources,
} from "./DirectResourceCleanup.request.ts";
import { isForbiddenDirectCleanupRoot } from "./DirectResourceCleanup.roots.ts";

const identity = {
  deviceOrVolume: "18446744073709551615",
  inodeOrFileId: "18446744073709551615",
  entryType: "file" as const,
};
const rustPlatform =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

function maximumResource(index: number): DirectCleanupResource {
  return {
    resourceId: `${index}`.padEnd(512, "r"),
    kind: "attachment",
    root: path.join(path.parse(process.cwd()).root, "managed"),
    relativePath: `${index}`.padEnd(4096, "p"),
    quarantineName: ".bigbud-cleanup-".padEnd(255, "q"),
    identity,
    rootIdentity: { ...identity, entryType: "directory" },
    parentIdentity: { ...identity, entryType: "directory" },
  };
}

describe("direct cleanup immutable requests", () => {
  it("pages maximum-sized fields by encoded frame bytes as well as item count", () => {
    const resources = Array.from({ length: 256 }, (_, index) => maximumResource(index));
    const pages = paginateDirectCleanupResources({
      operationId: "o".repeat(512),
      planDigest: "a".repeat(64),
      platform: rustPlatform,
      resources,
    });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map((resource) => resource.resourceId)).toEqual(
      resources.map((resource) => resource.resourceId),
    );
    for (const [pageOrdinal, page] of pages.entries()) {
      const request = buildDirectCleanupRequest({
        requestId: `cleanup:${String(pageOrdinal).padEnd(64, "f")}`,
        operationId: "o".repeat(512),
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        deadlineUnixMs: Number.MAX_SAFE_INTEGER,
        platform: rustPlatform,
        resources: page,
      });
      expect(encodeDirectCleanupRequest(request).byteLength).toBeLessThanOrEqual(
        REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
      );
      expect(page.length).toBeLessThanOrEqual(256);
    }
  });

  it("uses the same explicit filesystem-root and home-root forbidden policy", () => {
    expect(isForbiddenDirectCleanupRoot(path.parse(process.cwd()).root)).toBe(true);
    expect(isForbiddenDirectCleanupRoot(homedir())).toBe(true);
    expect(isForbiddenDirectCleanupRoot(path.join(homedir(), "managed"))).toBe(false);
  });
});
