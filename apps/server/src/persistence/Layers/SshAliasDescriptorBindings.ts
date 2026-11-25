import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type SshAliasDescriptorCheck = "unbound" | "match" | "changed";

const hex = (digest: Uint8Array) => {
  if (digest.length !== 32) throw new Error("An SSH alias descriptor is exactly 32 bytes.");
  return Buffer.from(digest).toString("hex");
};

/** Compare the owner-resolved descriptor with this profile's approval. Never writes. */
export const checkSshAliasDescriptor = Effect.fn("checkSshAliasDescriptor")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
  targetId: string,
  digest: Uint8Array,
) {
  const [row] = yield* sql<{ digest: string }>`
    SELECT descriptor_digest AS digest FROM ssh_alias_descriptor_bindings
    WHERE profile_scope = ${profileScope} AND target_id = ${targetId}
  `;
  const result: SshAliasDescriptorCheck =
    row === undefined ? "unbound" : row.digest === hex(digest) ? "match" : "changed";
  return result;
});

/**
 * Record an explicit approval. `firstUse` only fills a missing row, so a save can never overwrite
 * a different approved descriptor; `reapprove` replaces it and is reserved for an explicit user
 * re-approval of a descriptor change that was presented to that user.
 */
export const approveSshAliasDescriptor = Effect.fn("approveSshAliasDescriptor")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
  targetId: string,
  digest: Uint8Array,
  mode: "firstUse" | "reapprove",
) {
  const value = hex(digest);
  const now = yield* Clock.currentTimeMillis;
  if (mode === "firstUse") {
    yield* sql`
      INSERT INTO ssh_alias_descriptor_bindings
        (profile_scope, target_id, descriptor_digest, approved_at)
      VALUES (${profileScope}, ${targetId}, ${value}, ${now})
      ON CONFLICT (profile_scope, target_id) DO NOTHING
    `;
  } else {
    yield* sql`
      INSERT INTO ssh_alias_descriptor_bindings
        (profile_scope, target_id, descriptor_digest, approved_at)
      VALUES (${profileScope}, ${targetId}, ${value}, ${now})
      ON CONFLICT (profile_scope, target_id)
      DO UPDATE SET descriptor_digest = excluded.descriptor_digest,
        approved_at = excluded.approved_at
    `;
  }
  return yield* checkSshAliasDescriptor(sql, profileScope, targetId, digest);
});
