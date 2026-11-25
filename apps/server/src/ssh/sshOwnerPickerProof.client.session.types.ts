import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PickerProofHealthClient } from "./sshOwnerPickerProof.client.health.ts";
import type { PickerProofListClient } from "./sshOwnerPickerProof.client.list.ts";
import type { PickerProofTerminalClient } from "./sshOwnerPickerProof.client.terminal.ts";
import type { PickerProofTrackedGitClient } from "./sshOwnerPickerProof.client.trackedPush.ts";
import type { PickerProofWorkspaceClient } from "./sshOwnerPickerProof.client.workspace.ts";
import type { PickerProofConnection, PickerProofTrust } from "./sshOwnerPickerProof.codec.ts";
import type { PickerProofDeploymentClient } from "./sshOwnerPickerProof.deployment.ts";
import type { PickerProofShellClient } from "./sshOwnerPickerProof.client.shell.ts";
import type { PickerProofPeerEnrollmentClient } from "./sshOwnerPickerProof.client.peerEnrollment.ts";
import type { PickerProofAliasClient } from "./sshOwnerPickerProof.client.aliases.ts";
import type { PickerProofProductionProxyClient } from "./sshOwnerPickerProof.client.productionProxy.ts";

export interface PickerProofSessionOptions {
  readonly profileBinding: Uint8Array;
  /**
   * Pinned fixture target, or the production client's primary target. A
   * production owner started without a target has none at spawn.
   */
  readonly targetId?: string;
  readonly sql: SqlClient.SqlClient;
  readonly major?: number;
}

export interface PickerProofHydratedStorage {
  readonly writerEpoch: string;
  readonly seq: number;
  readonly disconnected: boolean;
}

/**
 * One resolved target on a shared owner (W3.7). Every request carries the
 * descriptor; grants are bound to this exact target and generation. Terminal
 * leases are target-scoped: a lease opened through one target never answers a
 * request for another.
 */
export interface PickerProofBoundTarget
  extends
    PickerProofListClient,
    PickerProofHealthClient,
    PickerProofTerminalClient,
    PickerProofProductionProxyClient {
  readonly targetId: string;
  /** Current generation; rotates on Connect/Disconnect. */
  readonly generation: Uint8Array;
  readonly hydratedStorage?: PickerProofHydratedStorage | undefined;
  inspectTrust(): Promise<PickerProofTrust>;
  approveTrust(challenge: Uint8Array): Promise<PickerProofTrust>;
  connect(): Promise<PickerProofConnection>;
  disconnect(): Promise<PickerProofConnection>;
}

export interface PickerProofOwner
  extends
    PickerProofListClient,
    PickerProofHealthClient,
    PickerProofWorkspaceClient,
    PickerProofTerminalClient,
    PickerProofDeploymentClient,
    PickerProofTrackedGitClient,
    PickerProofShellClient,
    PickerProofPeerEnrollmentClient,
    PickerProofAliasClient {
  readonly ownerEpoch: Uint8Array;
  /** The owner started without a pinned target (W3.7). */
  readonly multiTarget: boolean;
  /** Current owner target generation; rotates on Connect/Disconnect. */
  readonly targetGeneration: Uint8Array;
  /** Owner-resolved alias route/trust digest; undefined without an alias policy. */
  readonly aliasDescriptor?: Uint8Array | undefined;
  /** The exact storage snapshot this session acknowledged during its handshake. */
  readonly hydratedStorage?: PickerProofHydratedStorage | undefined;
  /** Fires once when the inherited channel is lost unexpectedly (not on detach). */
  onLost(listener: () => void): () => void;
  /** Binds one target for per-target requests (W3.7). */
  bindTarget(
    input: import("./sshOwnerPickerProof.codec.target.ts").ProofTargetDescriptorInput,
  ): PickerProofBoundTarget;
  inspectTrust(): Promise<PickerProofTrust>;
  approveTrust(challenge: Uint8Array): Promise<PickerProofTrust>;
  connect(): Promise<PickerProofConnection>;
  disconnect(): Promise<PickerProofConnection>;
  unlockSyntheticPosixPassword(): Promise<void>;
  close(): Promise<void>;
}
