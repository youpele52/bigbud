import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentLifecycle } from "./remoteAgentLifecycle.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

export type Entry = {
  readonly binding?: RemoteAgentRuntimeBinding;
  readonly lifecycle: RemoteAgentLifecycle;
  connecting: Promise<RemoteAgentConnection> | undefined;
  readonly executionTargetId: string;
  closed: boolean;
  transportLost: boolean;
};
