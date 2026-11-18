import type { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentControl } from "../../remote-agent/remoteAgentControl.ts";

/** Execution/ownership scope independent of the workspace's user-facing target label. */
export interface OwnedPtyRuntime {
  readonly targetId: string;
  readonly pool: RemoteAgentConnectionPool;
  readonly owners: () => RemoteAgentOwnerStore;
  readonly control: () => Promise<Pick<RemoteAgentControl, "registry">>;
  /** Positive evidence for read-only PID inspection; never permission to reap a child. */
  readonly pidNamespace: "backend-host" | "ssh-host";
}
