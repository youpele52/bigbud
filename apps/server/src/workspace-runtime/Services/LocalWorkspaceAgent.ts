/**
 * The one local `bigbud-remote-agent --ephemeral` process the server runs for local workspaces.
 * Watch and search share it, so search never spawns a second agent.
 */
import { ServiceMap } from "effect";

import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";

export interface LocalWorkspaceAgentShape {
  /** The live connection; the agent starts lazily and restarts with backoff after a crash. */
  readonly getConnection: () => Promise<RemoteAgentConnection>;
  readonly getWorkspaceClient: () => Promise<RemoteAgentWorkspaceClient>;
}

export class LocalWorkspaceAgent extends ServiceMap.Service<
  LocalWorkspaceAgent,
  LocalWorkspaceAgentShape
>()("bigbud/workspace-runtime/Services/LocalWorkspaceAgent") {}
