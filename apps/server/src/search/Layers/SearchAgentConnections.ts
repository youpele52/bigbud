import { Layer } from "effect";

import {
  getConfiguredRemoteAgentComposition,
  isRemoteAgentExecutionTarget,
} from "../../remote-agent/remoteAgentDefault.ts";
import { SearchAgentConnections } from "../Services/SearchAgentConnections.ts";

/** Reads the configured remote agent pool without dialing (`liveConnection`). */
export const SearchAgentConnectionsLive = Layer.sync(SearchAgentConnections, () => {
  const composition = getConfiguredRemoteAgentComposition();
  const managed = (executionTargetId: string) =>
    composition !== null && isRemoteAgentExecutionTarget(executionTargetId);
  return {
    remote: (executionTargetId) =>
      composition && managed(executionTargetId)
        ? composition.pool.liveConnection(executionTargetId)
        : null,
    isManagedAgentTarget: managed,
  };
});
