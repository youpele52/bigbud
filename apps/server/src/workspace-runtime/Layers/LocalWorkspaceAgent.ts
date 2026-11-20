import { Effect, Layer, Option } from "effect";

import { LocalWorkspaceWatchAgent } from "../../remote-agent/localWorkspaceWatchAgent.ts";
import { isThisComputerSearchAllowedByPolicy } from "../../search/SystemSearch.policy.ts";
import { ServerConfig } from "../../startup/config.ts";
import {
  LocalWorkspaceAgent,
  type LocalWorkspaceAgentShape,
} from "../Services/LocalWorkspaceAgent.ts";

type ClosableAgent = LocalWorkspaceAgentShape & { readonly close: () => void };

/**
 * Owns the shared local agent for the layer's lifetime and closes it on release. Only the
 * desktop-embedded backend starts it with `--os-index` ("this computer" search) on every desktop
 * platform (Spotlight, Windows Search, `locate`), and never when the managed-device policy turns
 * that search off.
 */
export function makeLocalWorkspaceAgentLayer(
  makeAgent: (options: { readonly osIndex: boolean }) => ClosableAgent = (options) =>
    new LocalWorkspaceWatchAgent(options),
) {
  return Layer.effect(
    LocalWorkspaceAgent,
    Effect.gen(function* () {
      const config = yield* Effect.serviceOption(ServerConfig);
      const osIndex =
        Option.isSome(config) &&
        config.value.mode === "desktop" &&
        isThisComputerSearchAllowedByPolicy();
      const agent = yield* Effect.acquireRelease(
        Effect.sync(() => makeAgent({ osIndex })),
        (owned) => Effect.sync(() => owned.close()),
      );
      return {
        getConnection: () => agent.getConnection(),
        getWorkspaceClient: () => agent.getWorkspaceClient(),
      } satisfies LocalWorkspaceAgentShape;
    }),
  );
}

export const LocalWorkspaceAgentLive = makeLocalWorkspaceAgentLayer();
