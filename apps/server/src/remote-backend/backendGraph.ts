import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RemoteAgentTargetTriple } from "@bigbud/shared/remoteAgentArtifact";
import {
  authenticateBackendGraphManifest,
  canonicalBackendGraphPayload,
} from "./backendGraph.manifest.ts";
import { verifyBackendGraphDirectory, type BackendGraphRoot } from "./backendGraph.files.ts";

declare const verifiedBackendGraph: unique symbol;
export interface VerifiedBackendGraph {
  readonly [verifiedBackendGraph]: true;
}
interface Snapshot {
  readonly root: string;
  readonly rootIdentity: BackendGraphRoot;
  readonly manifestDigest: string;
  readonly nodePath: string;
  readonly nodeSha256: string;
  readonly entryPath: string;
  readonly entrySha256: string;
  readonly version: string;
  readonly target: RemoteAgentTargetTriple;
}
const verified = new WeakMap<
  VerifiedBackendGraph,
  {
    readonly snapshot: Snapshot;
    readonly manifest: ReturnType<typeof authenticateBackendGraphManifest>;
  }
>();

/** Caller supplies pinned release trust; a manifest/URL cannot supply its own trust store. */
export async function verifyBackendGraph(input: {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly manifest: unknown;
  readonly trustStore: Readonly<Record<string, string>>;
  readonly target: RemoteAgentTargetTriple;
}): Promise<VerifiedBackendGraph> {
  const manifest = authenticateBackendGraphManifest(input.manifest, input.trustStore, input.target);
  const rootIdentity = await verifyBackendGraphDirectory(input.root, manifest, input.signal);
  const token = Object.freeze({}) as VerifiedBackendGraph;
  verified.set(token, {
    manifest,
    snapshot: Object.freeze({
      root: input.root,
      rootIdentity,
      manifestDigest: createHash("sha256")
        .update(canonicalBackendGraphPayload(manifest))
        .digest("hex"),
      nodePath: join(input.root, manifest.node),
      nodeSha256: manifest.files.find((file) => file.path === manifest.node)!.sha256,
      entryPath: join(input.root, manifest.entry),
      entrySha256: manifest.files.find((file) => file.path === manifest.entry)!.sha256,
      version: manifest.version,
      target: manifest.target,
    }),
  });
  return token;
}

/** Provisioning must require the actual opaque token, then revalidate immediately before use.
 * Publication still needs a serialized no-replace transaction; verification alone cannot supply it. */
export async function revalidateBackendGraph(
  token: VerifiedBackendGraph,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const record = verified.get(token);
  if (!record) throw new Error("Backend graph provenance requires an original verified token.");
  const identity = await verifyBackendGraphDirectory(record.snapshot.root, record.manifest, signal);
  if (
    identity.dev !== record.snapshot.rootIdentity.dev ||
    identity.ino !== record.snapshot.rootIdentity.ino ||
    identity.ctimeNs !== record.snapshot.rootIdentity.ctimeNs
  )
    throw new Error("Verified executable graph root was replaced or modified.");
  return record.snapshot;
}

/** Original proof only. Its immutable member projection is useful for the native pre-Node guard;
 * the returned data alone never substitutes for revalidation at a later side-effect boundary. */
export async function projectVerifiedBackendGraph(
  token: VerifiedBackendGraph,
  signal?: AbortSignal,
) {
  const snapshot = await revalidateBackendGraph(token, signal);
  const record = verified.get(token);
  if (!record) throw new Error("Backend graph provenance requires an original verified token.");
  return Object.freeze({
    ...snapshot,
    node: record.manifest.node,
    entry: record.manifest.entry,
    files: record.manifest.files,
  });
}
