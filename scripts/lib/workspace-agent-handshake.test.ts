import { describe, expect, it } from "vitest";

import { cleanupAuthorization, cleanupPageDigest } from "./workspace-agent-handshake.ts";

describe("workspace agent cleanup smoke digests", () => {
  it("matches the Rust canonical page and authorization digest contract", () => {
    const identity = { device: "1", inode: "2", type: 1 };
    const directory = { device: "1", inode: "3", type: 2 };
    const pageDigest = cleanupPageDigest({
      resourceId: "resource",
      rootHandle: "root-0",
      relativePath: "target",
      quarantineName: ".bigbud-cleanup-target",
      identity,
      rootIdentity: directory,
      parentIdentity: directory,
    });

    expect(pageDigest.toString("hex")).toBe(
      "6fc17b0f4cdbcfc2f9fbb2c0a03188101bc902e70b2b80f3ad2af60d20b2ae75",
    );
    expect(
      cleanupAuthorization({
        requestId: "request",
        operationId: "operation",
        planDigest: Buffer.alloc(32, 2),
        pageDigest,
        proofDigest: Buffer.alloc(32, 3),
        deadlineUnixMs: 123,
        platform: "linux",
      }).toString("hex"),
    ).toBe("ad6339ed43eb2f370fed7320046deb57290bfe8f45208ccc8d592ffe35bccbdf");
  });
});
