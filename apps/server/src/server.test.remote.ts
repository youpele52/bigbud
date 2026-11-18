/**
 * Remote-mode seam helpers for the `server.remote.*` multi-client acceptance tests.
 *
 * The routes mirror `makeRemoteClientRoutesLayer` (handshake + `/ws` behind the global remote
 * client authorization middleware) without the mobile-owner routes, whose native inputs are not
 * part of the multi-client contract. Orchestration runs on a real engine, receipt store and
 * projection pipeline over in-memory SQLite; only provider runtimes are absent.
 */
import { generateKeyPairSync } from "node:crypto";
import * as Http from "node:http";

import { REMOTE_BACKEND_CLIENT_RPC_REVISION } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { version } from "../package.json" with { type: "json" };
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { ComputerUseDisabledTestLayer } from "./orchestration/Layers/OrchestrationEngine.test.helpers.ts";
import { ProjectionCatalogQueryLive } from "./orchestration/Layers/ProjectionCatalogQuery.ts";
import { ProjectionOperationalStateQueryLive } from "./orchestration/Layers/ProjectionOperationalStateQuery.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionCatalogQuery } from "./orchestration/Services/ProjectionCatalogQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  makeRemoteClientHandshakeRoute,
  remoteClientAuthorizationLive,
} from "./remote-backend/clientRoutes.ts";
import { RemoteBackendIdentityService } from "./remote-backend/identity.service.ts";
import { buildAppUnderTest } from "./server.test.app.ts";
import type { BuildAppUnderTestOptions } from "./server.test.app.types.ts";
import { ServerConfig } from "./startup/config.ts";
import { toDispatchCommandError } from "./ws/wsDispatchCommandError.ts";
import { makeBootstrapCommandLock } from "./ws/wsBootstrap.lock.ts";
import { makeWebsocketRpcRouteLayer } from "./ws/ws.ts";
import { ServerSettingsService } from "./ws/serverSettings.ts";

export const REMOTE_TEST_TOKEN = "remote-multi-client-secret";

const { publicKey } = generateKeyPairSync("ed25519");
const remoteIdentityFixture = Layer.succeed(RemoteBackendIdentityService, {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  publicKey,
  signChallenge: () => {
    throw new Error("The remote client surface must not sign challenges.");
  },
});

/** The client half of `makeRemoteClientRoutesLayer`, served by the real seam app. */
export const remoteClientRoutesUnderTest = Layer.unwrap(
  Effect.gen(function* () {
    const withBootstrapCommandLock = yield* makeBootstrapCommandLock();
    return Layer.mergeAll(
      makeRemoteClientHandshakeRoute(version).pipe(
        HttpRouter.provideRequest(remoteIdentityFixture),
      ),
      makeWebsocketRpcRouteLayer(withBootstrapCommandLock, { remoteClientRouter: true }),
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
  }),
);

function makeRemoteEngineRuntime() {
  return ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(ProjectionCatalogQueryLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ProjectionOperationalStateQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ComputerUseDisabledTestLayer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-remote-multi-client-" }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

/** A real engine shared by every client of one remote backend under test. */
export const makeRemoteBackendUnderTest = (options?: BuildAppUnderTestOptions) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(Effect.sync(makeRemoteEngineRuntime), (owned) =>
      Effect.promise(() => owned.dispose()),
    );
    const engine = yield* Effect.promise(() =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    );
    const catalog = yield* Effect.promise(() =>
      runtime.runPromise(Effect.service(ProjectionCatalogQuery)),
    );
    const config = yield* buildAppUnderTest({
      ...options,
      routes: remoteClientRoutesUnderTest,
      config: { mode: "remote", authToken: REMOTE_TEST_TOKEN, ...options?.config },
      layers: {
        ...options?.layers,
        orchestrationEngine: engine,
        projectionCatalogQuery: catalog,
        // The production gateway minus the native-workspace coordinator, which needs providers.
        commandGateway: {
          dispatchNormalized: ({ command }) =>
            engine
              .dispatch(command)
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              ),
        },
      },
    });
    const sql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.promise(() => runtime.runPromise(effect));
    return { config, engine, sql };
  });

export const remoteWsUrl = (input?: {
  readonly revision?: string | null;
  readonly token?: string;
}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const url = new URL(`ws://127.0.0.1:${address.port}/ws`);
    url.searchParams.set("token", input?.token ?? REMOTE_TEST_TOKEN);
    const revision =
      input?.revision === undefined ? String(REMOTE_BACKEND_CLIENT_RPC_REVISION) : input.revision;
    if (revision !== null) url.searchParams.set("clientRpcRevision", revision);
    return url.toString();
  });

export interface RawUpgradeOutcome {
  readonly upgraded: boolean;
  readonly status: number;
  readonly body: string;
}

/** A raw upgrade attempt, so refusals expose their HTTP status and body to the test. */
export function attemptRawUpgrade(wsUrl: string): Promise<RawUpgradeOutcome> {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const request = Http.request({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      // A fresh connection per attempt; a pooled socket would carry the prior upgrade attempt.
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ upgraded: true, status: response.statusCode ?? 0, body: "" });
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ upgraded: false, status: response.statusCode ?? 0, body }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}
