/**
 * Remote agent connections `search.query` may use. Search only uses links that are already up:
 * it never dials, installs or reconnects a remote just to search (plan §4).
 */
import { ServiceMap } from "effect";

import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";

export interface SearchAgentConnectionsShape {
  /** The ready managed-agent connection for a remote target, or null. */
  readonly remote: (executionTargetId: string) => RemoteAgentConnection | null;
  /** True when a managed agent serves the target; false for SSH-only hosts. */
  readonly isManagedAgentTarget: (executionTargetId: string) => boolean;
}

export class SearchAgentConnections extends ServiceMap.Service<
  SearchAgentConnections,
  SearchAgentConnectionsShape
>()("bigbud/search/Services/SearchAgentConnections") {}
