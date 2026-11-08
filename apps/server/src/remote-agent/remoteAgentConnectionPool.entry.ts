import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentLifecycle } from "./remoteAgentLifecycle.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

export type Entry = {
  readonly binding?: RemoteAgentRuntimeBinding;
  readonly lifecycle: RemoteAgentLifecycle;
  connecting: Promise<RemoteAgentConnection> | undefined;
  readonly executionTargetId: string;
  closed: boolean;
  transportLost: boolean;
};

/** A new pool entry; a bound entry validates the runtime identity and epoch of every hello. */
export function makeRemoteAgentPoolEntry(
  executionTargetId: string,
  binding: RemoteAgentRuntimeBinding | undefined,
  create: () => Promise<RemoteAgentConnection>,
): Entry {
  return {
    executionTargetId,
    ...(binding ? { binding } : {}),
    lifecycle: new RemoteAgentLifecycle({
      create,
      ...(binding
        ? {
            expectedEpoch: binding.expectedEpoch,
            validateHello: (hello: RemoteAgentHello) =>
              assertRemoteAgentRuntimeHello(binding.runtime, hello),
          }
        : {}),
    }),
    connecting: undefined,
    closed: false,
    transportLost: false,
  };
}
