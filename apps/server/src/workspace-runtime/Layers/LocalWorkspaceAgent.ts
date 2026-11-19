import { Effect, Layer } from "effect";

import { LocalWorkspaceWatchAgent } from "../../remote-agent/localWorkspaceWatchAgent.ts";
import {
  LocalWorkspaceAgent,
  type LocalWorkspaceAgentShape,
} from "../Services/LocalWorkspaceAgent.ts";

/** Owns the shared local agent for the layer's lifetime and closes it on release. */
export function makeLocalWorkspaceAgentLayer(
  makeAgent: () => LocalWorkspaceAgentShape & { readonly close: () => void } = () =>
    new LocalWorkspaceWatchAgent(),
) {
  return Layer.effect(
    LocalWorkspaceAgent,
    Effect.map(
      Effect.acquireRelease(Effect.sync(makeAgent), (agent) => Effect.sync(() => agent.close())),
      (agent): LocalWorkspaceAgentShape => ({
        getConnection: () => agent.getConnection(),
        getWorkspaceClient: () => agent.getWorkspaceClient(),
      }),
    ),
  );
}

export const LocalWorkspaceAgentLive = makeLocalWorkspaceAgentLayer();
