import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  listUnresolvedSshOwnerRetirements,
  type SshOwnerRetirementRow,
} from "../persistence/Layers/SshOwnerRetirement.ts";

/**
 * State B hydrates into the owner before SSH admission opens (cutover §c step
 * 5). Every category is read from durable storage, never inferred from a
 * socket, a process name or an idle interval.
 *
 * @module sshOwnerProductionHydration
 */

export interface SshOwnerHydrationSnapshot {
  readonly durableDisconnects: ReadonlyArray<{
    readonly targetId: string;
    readonly disconnectedAt: number;
  }>;
  readonly aliasDescriptorBindings: ReadonlyArray<{
    readonly targetId: string;
    readonly descriptorDigest: string;
  }>;
  readonly retirementMirror: ReadonlyArray<SshOwnerRetirementRow>;
  readonly paneBindings: ReadonlyArray<{
    readonly ownerKey: string;
    readonly state: string;
  }>;
}

export const readSshOwnerHydrationSnapshot = Effect.fn("readSshOwnerHydrationSnapshot")(function* (
  sql: SqlClient.SqlClient,
  profileScope: string,
) {
  const durableDisconnects = yield* sql<{
    readonly targetId: string;
    readonly disconnectedAt: number;
  }>`
      SELECT target_id AS targetId, disconnected_at AS disconnectedAt
      FROM remote_execution_target_disconnects ORDER BY target_id
    `;
  const aliasDescriptorBindings = yield* sql<{
    readonly targetId: string;
    readonly descriptorDigest: string;
  }>`
      SELECT target_id AS targetId, descriptor_digest AS descriptorDigest
      FROM ssh_alias_descriptor_bindings
      WHERE profile_scope = ${profileScope}
      ORDER BY target_id
    `;
  const retirementMirror = yield* listUnresolvedSshOwnerRetirements(sql, profileScope);
  const paneBindings = yield* sql<{
    readonly ownerKey: string;
    readonly state: string;
  }>`
      SELECT owner_key AS ownerKey, state FROM direct_shell_launch_owners
      ORDER BY owner_key
    `;
  return {
    durableDisconnects,
    aliasDescriptorBindings,
    retirementMirror,
    paneBindings,
  } satisfies SshOwnerHydrationSnapshot;
});
