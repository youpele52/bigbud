import { homedir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as protocolCodec from "../../remote-agent/remoteAgentProtocol.codec.ts";
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

const paginationMetadata = {
  operationId: "o".repeat(512),
  planDigest: "a".repeat(64),
  platform: rustPlatform,
};

function encodedPageSize(resources: ReadonlyArray<DirectCleanupResource>): number {
  const request = buildDirectCleanupRequest({
    ...paginationMetadata,
    requestId: `cleanup:${"f".repeat(64)}`,
    proofDigest: "f".repeat(64),
    deadlineUnixMs: Number.MAX_SAFE_INTEGER,
    resources,
  });
  return (
    protocolCodec.encodeFramePayload({ type: "resourceCleanupRequest", value: request }).length + 4
  );
}

function expectMaximalPages(resources: ReadonlyArray<DirectCleanupResource>): void {
  const pages = paginateDirectCleanupResources({ ...paginationMetadata, resources });
  expect(pages.flat()).toEqual(resources);
  let offset = 0;
  for (const page of pages) {
    expect(page.length).toBeGreaterThan(0);
    expect(page.length).toBeLessThanOrEqual(256);
    expect(encodedPageSize(page)).toBeLessThanOrEqual(REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES);
    offset += page.length;
    if (page.length < 256 && offset < resources.length) {
      expect(encodedPageSize([...page, resources[offset]!])).toBeGreaterThan(
        REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
      );
    }
  }
}

describe("direct cleanup immutable requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pages maximum-sized fields by encoded frame bytes as well as item count", () => {
    const encode = vi.spyOn(protocolCodec, "encodeDelimitedFrame");
    const resources = Array.from({ length: 256 }, (_, index) => maximumResource(index));
    const pages = paginateDirectCleanupResources({
      operationId: "o".repeat(512),
      planDigest: "a".repeat(64),
      platform: rustPlatform,
      resources,
    });

    expect(pages.length).toBeGreaterThan(1);
    // One full-page probe plus at most eight binary-search probes per page.
    expect(encode.mock.calls.length).toBeGreaterThan(0);
    expect(encode.mock.calls.length).toBeLessThanOrEqual(pages.length * 9);
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

  it("uses maximal byte-bounded prefixes with mixed UTF-8 fields and multiple roots", () => {
    const resources = Array.from({ length: 360 }, (_, index) => ({
      ...maximumResource(index),
      root: path.join(path.parse(process.cwd()).root, `managed-${index % 129}`),
      relativePath: `${index}-${"🖐".repeat(index % 3 === 0 ? 1023 : 900)}`,
    }));
    expectMaximalPages(resources);
  });

  it("uses the count limit for small resources and does not encode an empty input", () => {
    const encode = vi.spyOn(protocolCodec, "encodeDelimitedFrame");
    expect(paginateDirectCleanupResources({ ...paginationMetadata, resources: [] })).toEqual([]);
    expect(encode).not.toHaveBeenCalled();
    const resources = Array.from({ length: 513 }, (_, index) => ({
      ...maximumResource(index),
      resourceId: `${index}`,
      relativePath: `${index}`,
    }));
    const pages = paginateDirectCleanupResources({ ...paginationMetadata, resources });
    expect(pages.map((page) => page.length)).toEqual([256, 256, 1]);
    expect(encode).toHaveBeenCalledTimes(3);
    expect(pages.flat()).toEqual(resources);
    expectMaximalPages(resources);
  });

  it("rejects an oversized resource both first and after a fitting prefix", () => {
    const oversized = {
      ...maximumResource(1),
      relativePath: "p".repeat(REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES),
    };
    for (const resources of [[oversized], [maximumResource(0), oversized]]) {
      expect(() => paginateDirectCleanupResources({ ...paginationMetadata, resources })).toThrow(
        "cleanup resource exceeds the protocol frame limit",
      );
    }
  });

  it("uses the same explicit filesystem-root and home-root forbidden policy", () => {
    expect(isForbiddenDirectCleanupRoot(path.parse(process.cwd()).root)).toBe(true);
    expect(isForbiddenDirectCleanupRoot(homedir())).toBe(true);
    expect(isForbiddenDirectCleanupRoot(path.join(homedir(), "managed"))).toBe(false);
  });
});
