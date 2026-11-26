import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  listUnresolvedSshOwnerRetirements,
  type SshOwnerRetirementRow,
} from "../persistence/Layers/SshOwnerRetirement.ts";
import {
  decodeSshOwnerPaneRow,
  type SshOwnerPaneRow,
} from "./sshOwnerProductionHydration.panes.ts";

/**
 * State B hydrates into the owner before SSH admission opens (cutover §c step
 * 5). Every category is read from durable storage, never inferred from a
 * socket, a process name or an idle interval.
 *
 * The unresolved retirement mirror and the retained direct pane bindings are
 * carried to the owner, which verifies them read-only and acknowledges the exact
 * set. Nothing here decides admission on its own.
 *
 * @module sshOwnerProductionHydration
 */

export interface SshOwnerPaneBinding {
  readonly ownerKey: string;
  /** Pane identity, when the durable record names it. */
  readonly threadId: string;
  readonly terminalId: string;
  /** Owner epoch recorded by the pane journal; empty when unprovable. */
  readonly ownerEpoch: string;
  readonly targetId: string;
  readonly generation: string;
  /** The durable reservation id, reused as the owner-side lease id. */
  readonly leaseId: string;
  readonly state: string;
  /** Recorded remote login-shell PID, when the journal has it. */
  readonly remoteShellPid?: number;
  /** A trusted lifecycle receipt confirmed termination for this reservation. */
  readonly terminated?: boolean;
}

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
  readonly paneBindings: ReadonlyArray<SshOwnerPaneBinding>;
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
  const paneRows = yield* sql<SshOwnerPaneRow>`
      SELECT owner_key AS ownerKey, reservation_id AS reservationId,
        controller_id AS controllerId, state, owner_json AS ownerJson
      FROM direct_shell_launch_owners
      ORDER BY owner_key
    `;
  return {
    durableDisconnects,
    aliasDescriptorBindings,
    retirementMirror,
    paneBindings: paneRows.map(decodeSshOwnerPaneRow),
  } satisfies SshOwnerHydrationSnapshot;
});
