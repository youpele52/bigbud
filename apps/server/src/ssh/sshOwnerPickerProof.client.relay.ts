import type {
  ClientRelayDeployment,
  ClientRelayOwnerRequest,
  ClientRelayOwnerLease,
  ClientRelaySshOwner,
} from "../remote-backend/clientRelay.ssh.owner.ts";
import { ClientRelayStdioSocket } from "../remote-backend/clientRelay.stdio.ts";
import {
  makeProofDuplexClient,
  type PickerProofDuplexLease,
} from "./sshOwnerPickerProof.client.agentProxy.ts";

const STDERR_LIMIT = 64 * 1024;

/** Bind only a trusted installed relay descriptor. The owner also checks the exact tuple. */
export function makeProofClientRelay(
  targetId: string,
  fixture: ClientRelayDeployment | undefined,
  takeChannels: Parameters<typeof makeProofDuplexClient>[2],
  execute: Parameters<typeof makeProofDuplexClient>[3],
): ClientRelaySshOwner["openClientRelay"] {
  const open = makeProofDuplexClient<ClientRelayOwnerRequest>(
    targetId,
    ({ deployment }) => {
      if (
        !fixture ||
        deployment.nodeBinary !== fixture.nodeBinary ||
        deployment.nodeSha256 !== fixture.nodeSha256 ||
        deployment.helperEntry !== fixture.helperEntry ||
        deployment.helperSha256 !== fixture.helperSha256 ||
        deployment.authorityId !== fixture.authorityId
      )
        return undefined;
      return { kind: "openProofClientRelay", ...fixture };
    },
    takeChannels,
    execute,
  );

  return async (request, signal) => proofRelayLease(await open(request, signal));
}

export function proofRelayLease(lease: PickerProofDuplexLease): ClientRelayOwnerLease {
  const stream = new ClientRelayStdioSocket(lease.pipes.stdout, lease.pipes.stdin);
  stream.on("error", () => {});
  let stderrBytes = 0;
  lease.pipes.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > STDERR_LIMIT)
      stream.destroy(new Error("SSH relay diagnostics exceeded limit."));
  });
  const exit = lease.reap.then((outcome): Awaited<ClientRelayOwnerLease["exit"]> => {
    if (outcome.code !== null) return { kind: "exited", code: outcome.code };
    if (outcome.signal) return { kind: "signaled", signal: outcome.signal };
    throw new Error("Rust SSH relay exit was not confirmed.");
  });
  void exit.catch(() => {});
  return { stream, exit, cancel: () => lease.close({ mode: "terminate", timeoutMs: 2_000 }) };
}
