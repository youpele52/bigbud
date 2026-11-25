import { randomBytes } from "node:crypto";

import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { ProofAgentProxyStatus } from "./sshOwnerPickerProof.codec.agentProxy.ts";
import type {
  ProofOpencodeServiceScope,
  ProofOpencodeState,
} from "./sshOwnerPickerProof.codec.opencode.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * Production per-target proxy leases. Both the agent proxy and OpenCode are
 * opened with owner-selected bindings: the caller never names an executable,
 * argument or listener, and each lease stays with the target that opened it.
 */
export interface PickerProofProductionProxyClient {
  /** Open the target's owner-selected agent proxy over its verified master. */
  openAgentProxy(): Promise<ProofAgentProxyStatus>;
  agentProxyStatus(lease: Uint8Array, pid: number): Promise<ProofAgentProxyStatus>;
  closeAgentProxy(
    lease: Uint8Array,
    pid: number,
    request: { readonly terminate: boolean; readonly timeoutMs: number },
  ): Promise<ProofAgentProxyStatus>;
  /** Bind the target's owner-selected OpenCode listener for one session. */
  openOpencode(scope: ProofOpencodeServiceScope): Promise<ProofOpencodeState>;
  opencodeStatus(lease: Uint8Array): Promise<ProofOpencodeState>;
  closeOpencode(lease: Uint8Array): Promise<ProofOpencodeState>;
}

type Execute = (operation: PickerProofOperation) => Promise<Outcome>;

const copyLease = (lease: Uint8Array) => {
  if (lease.length !== PROOF_TOKEN_BYTES) throw new PickerProofOwnerError("invalidOperands");
  return Uint8Array.from(lease);
};

export function makePickerProofProductionProxyClient(
  execute: Execute,
): PickerProofProductionProxyClient {
  const agent = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "proofAgentProxy" ? outcome.value : invalid();
  };
  const opencode = async (operation: PickerProofOperation) => {
    const outcome = await execute(operation);
    return outcome.kind === "proofOpencode" ? outcome.value : invalid();
  };
  return {
    // An empty binding is the production request: the owner refuses it unless
    // its own installed-agent recipe exists, and a fixture owner refuses it too.
    openAgentProxy: () => agent({ kind: "openProofAgentProxy", binaryPath: "", sha256: "" }),
    agentProxyStatus: (lease, pid) =>
      agent({ kind: "proofAgentProxyStatus", lease: copyLease(lease), pid }),
    closeAgentProxy(lease, pid, request) {
      if (
        !Number.isInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        request.timeoutMs > 60_000
      )
        throw new PickerProofOwnerError("invalidOperands");
      return agent({
        kind: "closeProofAgentProxy",
        lease: copyLease(lease),
        pid,
        terminate: request.terminate,
        timeoutMs: request.timeoutMs,
      });
    },
    openOpencode: (scope) =>
      opencode({
        kind: "proofOpencodeOpen",
        lease: randomBytes(PROOF_TOKEN_BYTES),
        serviceScope: {
          threadId: scope.threadId,
          sessionEpoch: scope.sessionEpoch,
          cwd: scope.cwd,
        },
      }),
    opencodeStatus: (lease) => opencode({ kind: "proofOpencodeStatus", lease: copyLease(lease) }),
    closeOpencode: (lease) => opencode({ kind: "proofOpencodeClose", lease: copyLease(lease) }),
  };
}
