import { createHash } from "node:crypto";
import { projectVerifiedBackendGraph, type VerifiedBackendGraph } from "./backendGraph.ts";

/** A config-pinned projection for Rust, not a release trust source or independent approval. */
export async function serializeVerifiedBackendGraphReceipt(
  token: VerifiedBackendGraph,
  signal?: AbortSignal,
) {
  const graph = await projectVerifiedBackendGraph(token, signal);
  for (const character of graph.root) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159))
      throw new Error("Native executable graph receipt requires an unambiguous root path.");
  }
  const raw = [
    "bigbud-backend-graph-receipt=1",
    `root=${graph.root}`,
    `root_dev=${graph.rootIdentity.dev}`,
    `root_ino=${graph.rootIdentity.ino}`,
    `root_ctime_ns=${graph.rootIdentity.ctimeNs}`,
    `manifest_sha256=${graph.manifestDigest}`,
    `node=${graph.node}`,
    `entry=${graph.entry}`,
    ...graph.files.map(
      (file) =>
        `file=${file.sha256}\t${file.sizeBytes}\t${file.executable ? "700" : "600"}\t${file.path}`,
    ),
    "",
  ].join("\n");
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
    throw new Error("Native executable graph receipt exceeds its byte budget.");
  return Object.freeze({
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    nodePath: graph.nodePath,
    nodeSha256: graph.nodeSha256,
    entryPath: graph.entryPath,
    entrySha256: graph.entrySha256,
    manifestDigest: graph.manifestDigest,
  });
}

/** Re-serialize from the ORIGINAL proof immediately before the caller's scoped side effects.
 * Previously returned strings/objects are never accepted as provenance. The caller owns its lock,
 * no-replace publication and finalizers; this helper neither writes nor starts any process. */
export async function withVerifiedBackendGraphReceipt<T>(
  token: VerifiedBackendGraph,
  consume: (
    receipt: Awaited<ReturnType<typeof serializeVerifiedBackendGraphReceipt>>,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const receipt = await serializeVerifiedBackendGraphReceipt(token, signal);
  signal?.throwIfAborted();
  return consume(receipt);
}
