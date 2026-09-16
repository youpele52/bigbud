import { createHash } from "node:crypto";

/** Hash new JSON request identities; never apply this to an already accepted wire digest. */
export function remoteAgentRequestDigest(input: unknown): Uint8Array {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error("Remote request identity is not serializable.");
  return createHash("sha256").update(serialized).digest();
}
