import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import type { MobilePublicationAuthority } from "./mobileOptionalPublication.authority.ts";
import { localSupervisorTarget } from "../remote-backend/localSupervisorIdentity.ts";
import { connectLocalSupervisorProxy } from "../remote-backend/localSupervisorTransport.ts";
import { verifyRemoteAgentRuntimeAdmission } from "./remoteAgentAdmission.verify.ts";
import { remoteAgentBuildId, remoteAgentRuntimeEqual } from "./remoteAgentRuntime.ts";
import type { MobileGatewayBinding } from "./mobileGatewayLifecycle.schema.ts";

/** Diagnostic-only proxy to the independently owned canonical agent; never starts its service. */
export async function currentMobileGatewayBinding(
  authority: MobilePublicationAuthority,
  owners: Pick<RemoteAgentOwnerStore, "getBinding">,
  signal: AbortSignal,
): Promise<MobileGatewayBinding> {
  signal.throwIfAborted();
  await authority.assertAuthority();
  const target = localSupervisorTarget(authority.pin.authority.authorityId);
  const binding = await owners.getBinding(target);
  if (!binding?.connectionId || !binding.expectedEpoch)
    throw new Error("Gateway requires an existing canonical P4 owner binding.");
  let connection: RemoteAgentConnection | undefined;
  const abort = () => connection?.close();
  signal.addEventListener("abort", abort, { once: true });
  let epoch: string;
  try {
    epoch = await verifyRemoteAgentRuntimeAdmission({
      target,
      runtime: binding.runtime,
      expectedEpoch: binding.expectedEpoch,
      connect: async (selected, runtime) => {
        if (selected !== target) throw new Error("Gateway cannot probe another agent authority.");
        await authority.assertAuthority();
        signal.throwIfAborted();
        connection = await connectLocalSupervisorProxy(runtime);
        if (signal.aborted) {
          connection.close();
          signal.throwIfAborted();
        }
        return connection;
      },
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  const final = await owners.getBinding(target);
  if (
    !final ||
    final.connectionId !== binding.connectionId ||
    final.expectedEpoch !== epoch ||
    !remoteAgentRuntimeEqual(final.runtime, binding.runtime)
  )
    throw new Error("Canonical agent binding changed during live gateway admission.");
  await authority.assertAuthority();
  signal.throwIfAborted();
  return Object.freeze({
    buildId: remoteAgentBuildId(binding.runtime),
    generation: binding.runtime.generation,
    epoch,
    connectionId: binding.connectionId,
  });
}
