import { makeRemoteBackendRelayRoute } from "../remote-backend/clientRelay.route.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Scope from "effect/Scope";
import { randomUUID } from "node:crypto";
import { WsRpcGroup } from "@bigbud/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";

import { ServerConfig } from "../startup/config";
import { makeWsRpcContext } from "./wsRpcContext";
import { makeWsRpcAutomationHandlers } from "./wsRpcHandlers.automation";
import { makeWsRpcGitTerminalHandlers } from "./wsRpcHandlers.gitTerminal";
import { makeWsRpcTerminalSessionHandlers } from "./wsRpcHandlers.terminalSession";
import { makeWsRpcTerminalLifecycleHandlers } from "./wsRpcHandlers.terminalLifecycle";
import { makeWsRpcWorktreeHandlers } from "./wsRpcHandlers.worktrees.ts";
import { makeWsRpcKanbanHandlers } from "./wsRpcHandlers.kanban";
import { makeWsRpcNotesHandlers } from "./wsRpcHandlers.notes";
import { makeWsRpcTeachHandlers } from "./wsRpcHandlers.teach";
import { makeWsRpcUsageHandlers } from "./wsRpcHandlers.usage";
import { makeWsRpcSubagentHandlers } from "./wsRpcHandlers.subagents";
import { makeWsRpcProviderControlsHandlers } from "./wsRpcHandlers.providerControls";
import { makeWsRpcOrchestrationServerHandlers } from "./wsRpcHandlers.orchestrationServer";
import { makeWsRpcBrowserHandlers } from "./wsRpcHandlers.browser";
import { makeWsRpcConnectionDiagnosticsHandlers } from "./wsRpcHandlers.connectionDiagnostics.ts";
import { makeWsRpcComputerUseHandlers } from "./wsRpcHandlers.computerUse.ts";
import { makeWsRpcCopilotRuntimeHandlers } from "./wsRpcHandlers.copilotRuntime.ts";
import { makeWsRpcPeerPairingHandlers } from "./wsRpcHandlers.peerPairing.ts";
import { makeWsRpcDatabaseCompactionHandlers } from "./wsRpcHandlers.databaseCompaction.ts";
import { makeWsRpcBackendDrainHandlers } from "./wsRpcHandlers.backendDrain.ts";
import { makeWsRpcSshOwnerAdmissionHandlers } from "./wsRpcHandlers.sshOwnerAdmission.ts";
import { makeWsRpcMetadataWarningHandlers } from "./wsRpcHandlers.metadataWarnings.ts";
import { makeWsRpcSearchHandlers } from "./wsRpcHandlers.search.ts";
import { makeWsRpcRemoteBackendDeploymentHandlers } from "./wsRpcHandlers.remoteBackendDeployment.ts";
import { makeWsRpcRemoteBackendUpdateHandlers } from "./wsRpcHandlers.remoteBackendUpdate.ts";
import { makeRuntimeUpdateSetupAuthority } from "../remote-backend/runtimeUpdate.authority.ts";
import { makeWsRpcProviderProvisioningHandlers } from "./wsRpcHandlers.providerProvisioning.ts";
import { makeProviderProvisioningAuthority } from "../provider-provisioning/provisionAuthority.ts";
import {
  isTrustedRetentionMutationOrigin,
  makeRetentionMutationAuthorization,
} from "./wsRetentionMutationAuthorization.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";
import { makeWsRpcHttpEffectWithSshMonitorCleanup } from "./wsSshMonitor.protocol.ts";
import { makeSshMonitorHandlers } from "./wsSshMonitor.handlers.ts";
import { forgetSshMonitorInstance } from "../ssh/sshMonitor.connections.ts";
import { authorizeWebsocketRpcConnection } from "./wsConnectionAuthorization.ts";
import { makeWsSshOwnerDevHandlers } from "./wsSshOwnerDev.ts";
import { withWsSshOwnerDevEntryActions } from "./wsSshOwnerDev.workspace.create.ts";
import { withWsSshOwnerDevWorkspace } from "./wsSshOwnerDev.workspace.ts";
import { withWsSshOwnerProductionWorkspace } from "./wsSshOwnerProduction.workspace.ts";
import { initializeProductionSshGuardedWriteJournal } from "../persistence/Layers/SshOwnerGuardedWriteJournal.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

const retentionMutationAuthorization = makeRetentionMutationAuthorization();

/** W2 T-files: production Files over the live owner; unchanged when activation is off. */
const withProductionWorkspace = Effect.fn("withProductionWorkspace")(function* <
  C extends Parameters<typeof withWsSshOwnerProductionWorkspace>[0],
>(base: C) {
  // A journal that cannot open leaves guarded saves refused, never unguarded.
  const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));
  const journal = sql
    ? Option.getOrUndefined(
        yield* initializeProductionSshGuardedWriteJournal(sql).pipe(Effect.option),
      )
    : undefined;
  const production = withWsSshOwnerProductionWorkspace(base, journal ? { journal } : {});
  if (!production) return base;
  return {
    ...base,
    workspaceMutations: production.workspaceMutations,
    workspaceRuntime: yield* production.workspaceRuntime.pipe(Effect.provide(WorkspacePathsLive)),
  };
});

const makeWsRpcLayer = (
  withBootstrapCommandLock: BootstrapCommandLock,
  worktreeScope: Scope.Scope,
  monitorInstanceId: string,
  relayHandlers: Awaited<
    Effect.Success<ReturnType<typeof makeRemoteBackendRelayRoute>>
  >["handlers"],
  sshOwner: Effect.Success<ReturnType<typeof makeWsSshOwnerDevHandlers>>,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const base = yield* makeWsRpcContext(withBootstrapCommandLock, monitorInstanceId);
      const context = sshOwner
        ? {
            ...base,
            workspaceMutations: withWsSshOwnerDevEntryActions(
              base.workspaceMutations,
              sshOwner.workspace,
            ),
            workspaceRuntime: yield* withWsSshOwnerDevWorkspace(
              base.workspaceRuntime,
              sshOwner.workspace,
            ).pipe(Effect.provide(WorkspacePathsLive)),
          }
        : yield* withProductionWorkspace(base);
      const computerUseHandlers = yield* makeWsRpcComputerUseHandlers(context);
      const databaseCompactionHandlers = yield* makeWsRpcDatabaseCompactionHandlers;
      const metadataWarningHandlers = yield* makeWsRpcMetadataWarningHandlers;
      const searchHandlers = yield* makeWsRpcSearchHandlers;
      const deploymentHandlers = yield* makeWsRpcRemoteBackendDeploymentHandlers();
      const runtimeUpdateHandlers = yield* makeWsRpcRemoteBackendUpdateHandlers();

      return WsRpcGroup.of({
        ...relayHandlers,
        ...deploymentHandlers,
        ...runtimeUpdateHandlers,
        ...makeWsRpcCopilotRuntimeHandlers(context),
        ...makeWsRpcPeerPairingHandlers(),
        ...makeWsRpcProviderProvisioningHandlers(context),
        ...makeWsRpcAutomationHandlers(context),
        ...makeWsRpcOrchestrationServerHandlers(context),
        ...makeWsRpcBrowserHandlers(),
        ...makeWsRpcKanbanHandlers(context),
        ...makeWsRpcNotesHandlers(context),
        ...makeWsRpcTeachHandlers(context),
        ...makeWsRpcUsageHandlers(context),
        ...makeWsRpcSubagentHandlers(context),
        ...makeWsRpcProviderControlsHandlers(context),
        ...makeWsRpcGitTerminalHandlers(context, worktreeScope),
        ...makeWsRpcTerminalSessionHandlers(context),
        ...makeWsRpcTerminalLifecycleHandlers(context),
        ...makeWsRpcWorktreeHandlers(context, worktreeScope),
        ...makeWsRpcConnectionDiagnosticsHandlers(context),
        ...computerUseHandlers,
        ...databaseCompactionHandlers,
        ...makeWsRpcBackendDrainHandlers(),
        ...makeWsRpcSshOwnerAdmissionHandlers(),
        ...metadataWarningHandlers,
        ...searchHandlers,
        ...sshOwner?.handlers,
        ...(sshOwner?.monitorHealth && makeSshMonitorHandlers(context, sshOwner.monitorHealth)),
      });
    }),
  );

export const makeWebsocketRpcRouteLayer = (
  withBootstrapCommandLock: BootstrapCommandLock,
  /** Only the remote client Unix socket router sets this; it gates D10 setup authority. */
  options: { readonly remoteClientRouter?: boolean } = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const setupAuthority = makeRuntimeUpdateSetupAuthority();
      const provisioningAuthority = makeProviderProvisioningAuthority();
      // Own accepted mutations for the HTTP server's lifetime, not the temporary RPC layer build.
      const worktreeScope = yield* Effect.scope;
      const monitorInstanceId = randomUUID();
      yield* Scope.addFinalizer(
        worktreeScope,
        Effect.sync(() => forgetSshMonitorInstance(monitorInstanceId)),
      );
      const sshOwner = options.remoteClientRouter
        ? undefined
        : yield* makeWsSshOwnerDevHandlers(monitorInstanceId);
      const relay = yield* makeRemoteBackendRelayRoute(monitorInstanceId, worktreeScope);
      const wsRpcRuntimeLayer = Layer.mergeAll(
        makeWsRpcLayer(
          withBootstrapCommandLock,
          worktreeScope,
          monitorInstanceId,
          relay.handlers,
          sshOwner,
        ),
        RpcSerialization.layerJson,
        retentionMutationAuthorization.layer,
        setupAuthority.layer,
        provisioningAuthority.layer,
      );
      const rpcWebSocketHttpEffect = yield* makeWsRpcHttpEffectWithSshMonitorCleanup(
        monitorInstanceId,
        relay.lifecycle,
      ).pipe(Effect.provide(wsRpcRuntimeLayer));

      return HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const authorization = authorizeWebsocketRpcConnection({
            mode: config.mode,
            authToken: config.authToken,
            url: request.url,
            headers: request.headers,
          });
          if (authorization !== "authorized")
            return HttpServerResponse.text("WebSocket connection unavailable", {
              status:
                authorization === "incompatible"
                  ? 426
                  : authorization === "invalid-url"
                    ? 400
                    : 401,
            });
          const trustedLocal =
            config.authToken !== undefined || isTrustedRetentionMutationOrigin(request.headers);
          const connection = {
            mode: config.mode,
            remoteClientRouter: options.remoteClientRouter === true,
            authorized: authorization === "authorized",
          };
          const requestWithAuthorization = request.modify({
            headers: provisioningAuthority.authorizeHeaders(
              setupAuthority.authorizeHeaders(
                retentionMutationAuthorization.authorizeHeaders(request.headers, trustedLocal),
                connection,
              ),
              { ...connection, trustedLocal },
            ),
          });
          return yield* rpcWebSocketHttpEffect.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, requestWithAuthorization),
          );
        }),
      );
    }),
  );
