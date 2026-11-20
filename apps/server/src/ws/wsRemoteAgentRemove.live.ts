import { Effect, Option } from "effect";

import type {
  ServerRemoveRemoteAgentInput,
  ServerRemoveRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteAgentInstall.ts";

import { CommandGateway } from "../command-gateway/Services/CommandGateway.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionCatalogQuery } from "../orchestration/Services/ProjectionCatalogQuery";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RemoteAgentInstallerService } from "../remote-agent/remoteAgentServerLayer.ts";
import { RemoteAgentUpdateCoordinator } from "../remote-agent/remoteAgentUpdate.coordinator.ts";
import { TerminalManager } from "../terminal/Services/Manager";
import { removeRemoteAgentEffect } from "./wsRemoteAgentRemove.ts";
import { makeRemoveRemoteAgentDependencies } from "./wsRemoteAgentRemove.dependencies.ts";

/**
 * The app's Remove agent effect for `bigbud remote-agent remove`, composed from live services.
 * Undefined when any required service is absent, so the CLI reports removal as unavailable.
 */
export const makeLiveRemoteAgentRemoval = Effect.gen(function* () {
  const installer = yield* Effect.serviceOption(RemoteAgentInstallerService);
  const coordinator = yield* Effect.serviceOption(RemoteAgentUpdateCoordinator);
  const providerService = yield* Effect.serviceOption(ProviderService);
  const terminalManager = yield* Effect.serviceOption(TerminalManager);
  const engine = yield* Effect.serviceOption(OrchestrationEngineService);
  const catalog = yield* Effect.serviceOption(ProjectionCatalogQuery);
  const gateway = yield* Effect.serviceOption(CommandGateway);
  if (
    Option.isNone(installer) ||
    Option.isNone(providerService) ||
    Option.isNone(terminalManager) ||
    Option.isNone(engine) ||
    Option.isNone(catalog) ||
    Option.isNone(gateway)
  )
    return undefined;
  const dependencies = makeRemoveRemoteAgentDependencies({
    remoteAgentInstaller: installer.value,
    ...(Option.isSome(coordinator) ? { remoteAgentUpdateCoordinator: coordinator.value } : {}),
    providerService: providerService.value,
    terminalManager: terminalManager.value,
    workspaces: {
      getReadModel: () => engine.value.getReadModel(),
      getProjectWorktreePaths: (input) => catalog.value.getProjectWorktreePaths(input),
      // The owner's local CLI acts as the signed-in person, like the app's Save.
      dispatch: (command) =>
        gateway.value.dispatchNormalized({
          command,
          context: {
            actor: "authenticated-user",
            source: "desktop",
            authorizationScope: "authenticated-session",
          },
        }),
    },
  });
  return (target: string, switchToDirectSsh: boolean): Promise<ServerRemoveRemoteAgentResult> =>
    Effect.runPromise(
      removeRemoteAgentEffect(
        {
          executionTargetId: target as ServerRemoveRemoteAgentInput["executionTargetId"],
          switchWorkspacesToDirectSsh: switchToDirectSsh,
        },
        dependencies,
      ),
    );
});
