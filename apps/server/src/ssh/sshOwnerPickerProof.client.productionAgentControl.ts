import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type {
  AgentControlOperands,
  AgentControlRuntime,
  AgentControlState,
} from "./sshOwnerPickerProof.codec.agentControl.ts";
import type { ClientRelayLeaseState } from "./sshOwnerPickerProof.codec.backend.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * U25 remote-agent control leases on one bound target. The caller-chosen lease token is the
 * operation identity: opening it again, or reading its status, returns the retained outcome
 * and never runs the kind a second time.
 */
export interface PickerProofProductionAgentControlClient {
  openAgentControl(lease: Uint8Array, control: AgentControlOperands): Promise<AgentControlState>;
  agentControlStatus(lease: Uint8Array): Promise<AgentControlState>;
  /** Cancel this lease only; the owner kills its child and confirms the reap. */
  cancelAgentControl(lease: Uint8Array): Promise<AgentControlState>;
  /** One installed-agent `--proxy` session for this registry runtime; bytes on the socket. */
  openAgentProxyLease(
    lease: Uint8Array,
    runtime: AgentControlRuntime,
  ): Promise<ClientRelayLeaseState>;
  agentProxyLeaseStatus(lease: Uint8Array): Promise<ClientRelayLeaseState>;
  /** Close this session only; the owner kills its child and confirms the reap. */
  closeAgentProxyLease(lease: Uint8Array): Promise<ClientRelayLeaseState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copyLease = (lease: Uint8Array) => {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
};

export function makePickerProofProductionAgentControlClient(
  execute: Execute,
): PickerProofProductionAgentControlClient {
  const state = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "agentControl" ? outcome.value : invalid();
  };
  const proxy = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "agentProxyLease" ? outcome.value : invalid();
  };
  return {
    openAgentControl: (lease, control) =>
      state({ kind: "agentControlOpen", lease: copyLease(lease), control }),
    agentControlStatus: (lease) => state({ kind: "agentControlStatus", lease: copyLease(lease) }),
    cancelAgentControl: (lease) => state({ kind: "agentControlCancel", lease: copyLease(lease) }),
    openAgentProxyLease: (lease, runtime) =>
      proxy({ kind: "agentProxyLeaseOpen", lease: copyLease(lease), runtime }),
    agentProxyLeaseStatus: (lease) =>
      proxy({ kind: "agentProxyLeaseStatus", lease: copyLease(lease) }),
    closeAgentProxyLease: (lease) =>
      proxy({ kind: "agentProxyLeaseClose", lease: copyLease(lease) }),
  };
}
