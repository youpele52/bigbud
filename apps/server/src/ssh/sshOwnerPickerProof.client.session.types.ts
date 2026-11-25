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

export interface PickerProofSessionOptions {
  readonly profileBinding: Uint8Array;
  readonly targetId: string;
  readonly sql: SqlClient.SqlClient;
  readonly major?: number;
}

export interface PickerProofHydratedStorage {
  readonly writerEpoch: string;
  readonly seq: number;
  readonly disconnected: boolean;
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
  /** Current owner target generation; rotates on Connect/Disconnect. */
  readonly targetGeneration: Uint8Array;
  /** Owner-resolved alias route/trust digest; undefined without an alias policy. */
  readonly aliasDescriptor?: Uint8Array | undefined;
  /** The exact storage snapshot this session acknowledged during its handshake. */
  readonly hydratedStorage?: PickerProofHydratedStorage;
  /** Fires once when the inherited channel is lost unexpectedly (not on detach). */
  onLost(listener: () => void): () => void;
  inspectTrust(): Promise<PickerProofTrust>;
  approveTrust(challenge: Uint8Array): Promise<PickerProofTrust>;
  connect(): Promise<PickerProofConnection>;
  disconnect(): Promise<PickerProofConnection>;
  unlockSyntheticPosixPassword(): Promise<void>;
  close(): Promise<void>;
}
