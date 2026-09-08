import { createHash } from "node:crypto";

import { encodeDelimitedFrame } from "../../remote-agent/remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  type RemoteAgentFrame,
} from "../../remote-agent/remoteAgentProtocol.ts";
import type {
  RemoteAgentResourceCleanupIdentity,
  RemoteAgentResourceCleanupRequest,
  RemoteAgentResourceCleanupResource,
} from "../../remote-agent/remoteAgentProtocol.resourceCleanup.ts";
import type { DirectCleanupResource } from "../Services/DirectResourceCleanupExecutor.ts";

const PAGE_DIGEST_DOMAIN = "bigbud.resource-cleanup.page.v1";
const AUTHORIZATION_DIGEST_DOMAIN = "bigbud.resource-cleanup.authorization.v1";
const MAX_RESOURCES_PER_PAGE = 256;

function updateBytes(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function updateString(hash: ReturnType<typeof createHash>, value: string): void {
  updateBytes(hash, Buffer.from(value, "utf8"));
}

function updateIdentity(
  hash: ReturnType<typeof createHash>,
  identity: RemoteAgentResourceCleanupIdentity | undefined,
): void {
  hash.update(Uint8Array.of(identity ? 1 : 0));
  if (!identity) return;
  updateString(hash, identity.deviceOrVolume);
  updateString(hash, identity.inodeOrFileId);
  hash.update(Uint8Array.of(identity.entryType === "file" ? 1 : 2));
}

export function directCleanupPageDigest(
  resources: ReadonlyArray<RemoteAgentResourceCleanupResource>,
): string {
  const hash = createHash("sha256");
  hash.update(`${PAGE_DIGEST_DOMAIN}\0`);
  for (const resource of resources) {
    updateString(hash, resource.resourceId);
    updateString(hash, resource.rootHandle);
    updateString(hash, resource.relativePath);
    updateString(hash, resource.quarantineName);
    updateIdentity(hash, resource.identity);
    updateIdentity(hash, resource.rootIdentity);
    updateIdentity(hash, resource.parentIdentity);
    hash.update(Uint8Array.of(1));
  }
  return hash.digest("hex");
}

export function directCleanupAuthorizationDigest(
  request: Omit<RemoteAgentResourceCleanupRequest, "authorizationDigest">,
): string {
  const hash = createHash("sha256");
  hash.update(`${AUTHORIZATION_DIGEST_DOMAIN}\0`);
  updateString(hash, request.requestId);
  updateString(hash, request.operationId);
  hash.update(request.planDigest);
  hash.update(request.pageDigest);
  hash.update(request.finalizeProofDigest);
  const deadline = Buffer.allocUnsafe(8);
  deadline.writeBigUInt64BE(BigInt(request.deadlineUnixMs));
  hash.update(deadline);
  updateString(hash, request.platform);
  return hash.digest("hex");
}

function wireResources(
  resources: ReadonlyArray<DirectCleanupResource>,
): ReadonlyArray<RemoteAgentResourceCleanupResource> {
  const roots = new Map<string, string>();
  return resources.map((resource) => {
    let rootHandle = roots.get(resource.root);
    if (!rootHandle) {
      rootHandle = `root-${roots.size}`;
      roots.set(resource.root, rootHandle);
    }
    return {
      resourceId: resource.resourceId,
      rootHandle,
      relativePath: resource.relativePath,
      quarantineName: resource.quarantineName,
      ...(resource.identity ? { identity: resource.identity } : {}),
      rootIdentity: resource.rootIdentity,
      parentIdentity: resource.parentIdentity,
      action: "delete",
    };
  });
}

export function buildDirectCleanupRequest(input: {
  readonly requestId: string;
  readonly operationId: string;
  readonly planDigest: string;
  readonly proofDigest: string;
  readonly deadlineUnixMs: number;
  readonly platform: string;
  readonly resources: ReadonlyArray<DirectCleanupResource>;
}): RemoteAgentResourceCleanupRequest {
  const resources = wireResources(input.resources);
  const withoutAuthorization = {
    requestId: input.requestId,
    operationId: input.operationId,
    pageDigest: Buffer.from(directCleanupPageDigest(resources), "hex"),
    deadlineUnixMs: input.deadlineUnixMs,
    platform: input.platform,
    resources,
    planDigest: Buffer.from(input.planDigest, "hex"),
    finalizeProofDigest: Buffer.from(input.proofDigest, "hex"),
  } satisfies Omit<RemoteAgentResourceCleanupRequest, "authorizationDigest">;
  return {
    ...withoutAuthorization,
    authorizationDigest: Buffer.from(directCleanupAuthorizationDigest(withoutAuthorization), "hex"),
  };
}

export function encodeDirectCleanupRequest(request: RemoteAgentResourceCleanupRequest): Uint8Array {
  return encodeDelimitedFrame({ type: "resourceCleanupRequest", value: request });
}

export function serializeDirectCleanupRequest(request: RemoteAgentResourceCleanupRequest): string {
  return JSON.stringify({
    ...request,
    pageDigest: Buffer.from(request.pageDigest).toString("hex"),
    planDigest: Buffer.from(request.planDigest).toString("hex"),
    finalizeProofDigest: Buffer.from(request.finalizeProofDigest).toString("hex"),
    authorizationDigest: Buffer.from(request.authorizationDigest).toString("hex"),
  });
}

export function deserializeDirectCleanupRequest(value: string): RemoteAgentResourceCleanupRequest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const request = {
    ...parsed,
    pageDigest: Buffer.from(String(parsed.pageDigest), "hex"),
    planDigest: Buffer.from(String(parsed.planDigest), "hex"),
    finalizeProofDigest: Buffer.from(String(parsed.finalizeProofDigest), "hex"),
    authorizationDigest: Buffer.from(String(parsed.authorizationDigest), "hex"),
  } as unknown as RemoteAgentResourceCleanupRequest;
  const encoded = encodeDirectCleanupRequest(request);
  if (
    request.resources.length === 0 ||
    request.resources.length > MAX_RESOURCES_PER_PAGE ||
    encoded.byteLength > REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES
  ) {
    throw new Error("stored cleanup request is invalid");
  }
  return request;
}

export function directCleanupAttemptId(input: {
  readonly operationId: string;
  readonly pageOrdinal: number;
  readonly attemptCount: number;
  readonly pageDigest: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `cleanup:${digest}`;
}

export function paginateDirectCleanupResources(input: {
  readonly operationId: string;
  readonly planDigest: string;
  readonly platform: string;
  readonly resources: ReadonlyArray<DirectCleanupResource>;
}): ReadonlyArray<ReadonlyArray<DirectCleanupResource>> {
  const pages: Array<Array<DirectCleanupResource>> = [];
  let page: Array<DirectCleanupResource> = [];
  for (const resource of input.resources) {
    const candidate = [...page, resource];
    const request = buildDirectCleanupRequest({
      requestId: `cleanup:${"f".repeat(64)}`,
      operationId: input.operationId,
      planDigest: input.planDigest,
      proofDigest: "f".repeat(64),
      deadlineUnixMs: Number.MAX_SAFE_INTEGER,
      platform: input.platform,
      resources: candidate,
    });
    const fits = candidate.length <= MAX_RESOURCES_PER_PAGE && requestFitsFrame(request);
    if (!fits) {
      if (page.length === 0) throw new Error("cleanup resource exceeds the protocol frame limit");
      pages.push(page);
      page = [resource];
      const single = buildDirectCleanupRequest({
        requestId: `cleanup:${"f".repeat(64)}`,
        operationId: input.operationId,
        planDigest: input.planDigest,
        proofDigest: "f".repeat(64),
        deadlineUnixMs: Number.MAX_SAFE_INTEGER,
        platform: input.platform,
        resources: page,
      });
      if (!requestFitsFrame(single)) {
        throw new Error("cleanup resource exceeds the protocol frame limit");
      }
    } else {
      page = candidate;
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function requestFitsFrame(request: RemoteAgentResourceCleanupRequest): boolean {
  try {
    return encodeDirectCleanupRequest(request).byteLength <= REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function assertDirectCleanupFrameMatches(
  request: RemoteAgentResourceCleanupRequest,
  encodedHex: string,
): Uint8Array {
  const encoded = encodeDirectCleanupRequest(request);
  if (Buffer.from(encoded).toString("hex") !== encodedHex) {
    throw new Error("stored cleanup request bytes do not match its immutable payload");
  }
  return encoded;
}

export function cleanupRequestFrame(request: RemoteAgentResourceCleanupRequest): RemoteAgentFrame {
  return { type: "resourceCleanupRequest", value: request };
}
