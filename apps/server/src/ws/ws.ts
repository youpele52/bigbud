import { makeRemoteBackendRelayRoute } from "../remote-backend/clientRelay.route.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { makeWsRpcDatabaseCompactionHandlers } from "./wsRpcHandlers.databaseCompaction.ts";
import { makeWsRpcMetadataWarningHandlers } from "./wsRpcHandlers.metadataWarnings.ts";
import {
  isTrustedRetentionMutationOrigin,
  makeRetentionMutationAuthorization,
} from "./wsRetentionMutationAuthorization.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";
import { makeWsRpcHttpEffectWithSshMonitorCleanup } from "./wsSshMonitor.protocol.ts";
import { forgetSshMonitorInstance } from "../ssh/sshMonitor.connections.ts";
import { authorizeWebsocketRpcConnection } from "./wsConnectionAuthorization.ts";

const retentionMutationAuthorization = makeRetentionMutationAuthorization();

const makeWsRpcLayer = (
  withBootstrapCommandLock: BootstrapCommandLock,
  worktreeScope: Scope.Scope,
  monitorInstanceId: string,
  relayHandlers: Awaited<
    Effect.Success<ReturnType<typeof makeRemoteBackendRelayRoute>>
  >["handlers"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const context = yield* makeWsRpcContext(withBootstrapCommandLock, monitorInstanceId);
      const computerUseHandlers = yield* makeWsRpcComputerUseHandlers(context);
      const databaseCompactionHandlers = yield* makeWsRpcDatabaseCompactionHandlers;
      const metadataWarningHandlers = yield* makeWsRpcMetadataWarningHandlers;

      return WsRpcGroup.of({
        ...relayHandlers,
        ...makeWsRpcCopilotRuntimeHandlers(context),
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
        ...makeWsRpcWorktreeHandlers(context, worktreeScope),
        ...makeWsRpcConnectionDiagnosticsHandlers(context),
        ...computerUseHandlers,
        ...databaseCompactionHandlers,
        ...metadataWarningHandlers,
      });
    }),
  );

export const makeWebsocketRpcRouteLayer = (withBootstrapCommandLock: BootstrapCommandLock) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Own accepted mutations for the HTTP server's lifetime, not the temporary RPC layer build.
      const worktreeScope = yield* Effect.scope;
      const monitorInstanceId = randomUUID();
      yield* Scope.addFinalizer(
        worktreeScope,
        Effect.sync(() => forgetSshMonitorInstance(monitorInstanceId)),
      );
      const relay = yield* makeRemoteBackendRelayRoute(monitorInstanceId, worktreeScope);
      const wsRpcRuntimeLayer = Layer.mergeAll(
        makeWsRpcLayer(withBootstrapCommandLock, worktreeScope, monitorInstanceId, relay.handlers),
        RpcSerialization.layerJson,
        retentionMutationAuthorization.layer,
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
          const requestWithAuthorization = request.modify({
            headers: retentionMutationAuthorization.authorizeHeaders(
              request.headers,
              config.authToken !== undefined || isTrustedRetentionMutationOrigin(request.headers),
            ),
          });
          return yield* rpcWebSocketHttpEffect.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, requestWithAuthorization),
          );
        }),
      );
    }),
  );
