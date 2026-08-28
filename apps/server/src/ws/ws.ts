import { Effect, Layer, Option } from "effect";
import { WsRpcGroup } from "@bigbud/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ServerConfig } from "../startup/config";
import { makeWsRpcContext } from "./wsRpcContext";
import { makeWsRpcAutomationHandlers } from "./wsRpcHandlers.automation";
import { makeWsRpcGitTerminalHandlers } from "./wsRpcHandlers.gitTerminal";
import { makeWsRpcKanbanHandlers } from "./wsRpcHandlers.kanban";
import { makeWsRpcNotesHandlers } from "./wsRpcHandlers.notes";
import { makeWsRpcTeachHandlers } from "./wsRpcHandlers.teach";
import { makeWsRpcUsageHandlers } from "./wsRpcHandlers.usage";
import { makeWsRpcOrchestrationServerHandlers } from "./wsRpcHandlers.orchestrationServer";
import { makeWsRpcBrowserHandlers } from "./wsRpcHandlers.browser";
import { makeWsRpcPluginHandlers } from "./wsRpcHandlers.plugins";
import {
  isTrustedRetentionMutationOrigin,
  makeRetentionMutationAuthorization,
} from "./wsRetentionMutationAuthorization.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";

const retentionMutationAuthorization = makeRetentionMutationAuthorization();

const makeWsRpcLayer = (withBootstrapCommandLock: BootstrapCommandLock) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const context = yield* makeWsRpcContext(withBootstrapCommandLock);

      return WsRpcGroup.of({
        ...makeWsRpcAutomationHandlers(context),
        ...makeWsRpcOrchestrationServerHandlers(context),
        ...makeWsRpcBrowserHandlers(),
        ...makeWsRpcKanbanHandlers(context),
        ...makeWsRpcNotesHandlers(context),
        ...makeWsRpcTeachHandlers(context),
        ...makeWsRpcUsageHandlers(context),
        ...makeWsRpcGitTerminalHandlers(context),
        ...makeWsRpcPluginHandlers(context),
      });
    }),
  );

export const makeWebsocketRpcRouteLayer = (withBootstrapCommandLock: BootstrapCommandLock) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const wsRpcRuntimeLayer = Layer.mergeAll(
        makeWsRpcLayer(withBootstrapCommandLock),
        RpcSerialization.layerJson,
        retentionMutationAuthorization.layer,
      );
      const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
        spanPrefix: "ws.rpc",
        spanAttributes: {
          "rpc.transport": "websocket",
          "rpc.system": "effect-rpc",
        },
      }).pipe(Effect.provide(wsRpcRuntimeLayer));

      return HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          if (config.authToken) {
            const url = HttpServerRequest.toURL(request);
            if (Option.isNone(url)) {
              return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
            }
            const token = url.value.searchParams.get("token");
            if (token !== config.authToken) {
              return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
            }
          }
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
