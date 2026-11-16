import { RemoteAgentConnection } from "./remoteAgentConnection";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool";
import { RemoteAgentPtyInventory } from "./remoteAgentPtyInventory";
import { assertSshTargetConnected } from "../ssh/sshTargetDisconnects";

/** Owns only a short-lived pinned proxy; never admission, preparation or the shared pool. */
export async function readRemoteAgentInventoryWithoutStart(
  target: string,
  binding: RemoteAgentRuntimeBinding,
  signal: AbortSignal,
  create: typeof RemoteAgentConnection.ssh = RemoteAgentConnection.ssh,
) {
  assertSshTargetConnected(target);
  let connection: RemoteAgentConnection | undefined;
  let disposed = false;
  const inventory = new RemoteAgentPtyInventory({
    getBound: async () => {
      signal.throwIfAborted();
      const acquired = await create({
        executionTargetId: target,
        runtime: binding.runtime,
        binaryPath: binding.runtime.binaryPath,
      });
      // SSH approval/creation may finish after this caller's bounded observation ended.
      if (disposed || signal.aborted) {
        acquired.close();
        throw new Error("Read-only terminal observation expired.");
      }
      connection = acquired;
      const hello = await acquired.handshake();
      assertRemoteAgentRuntimeHello(binding.runtime, hello);
      if (hello.agentEpoch !== binding.expectedEpoch)
        throw new Error("Remote supervisor epoch changed; terminal state is unknown.");
      if (
        !hello.capabilities.some(
          (capability) => capability.name === "terminal.pty-inventory" && capability.major === 1,
        )
      )
        throw new Error("Remote terminal inventory is unsupported.");
      return acquired;
    },
  });
  try {
    return await inventory.list(target, binding, signal);
  } finally {
    disposed = true;
    connection?.close();
  }
}
