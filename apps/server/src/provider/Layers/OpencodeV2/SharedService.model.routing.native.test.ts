import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS, MessageId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { AnalyticsService } from "../../../telemetry/Services/AnalyticsService.ts";
import { ProviderService } from "../../Services/ProviderService.ts";
import { ProviderAdapterRegistry } from "../../Services/ProviderAdapterRegistry.ts";
import { makeAdapterLookup } from "../ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "../ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../ProviderSessionDirectory.ts";
import {
  ensureSessionForThread,
  sendTurnForThread,
} from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.settings.test.helpers.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { makeV2Client } from "./Client.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { Service } from "@opencode/client/service";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));
vi.mock(
  "../../../orchestration/Layers/ProviderCommandReactorSessionOps.threadContext.ts",
  async (original) => ({
    ...(await original<
      typeof import("../../../orchestration/Layers/ProviderCommandReactorSessionOps.threadContext.ts")
    >()),
    resolveAndExportThreadContextPath: () => Effect.void,
  }),
);

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;

it.skipIf(!binary || !version || process.platform !== "darwin")(
  "routes captured cross-subprovider model/variant switching through application, ProviderService and orchestration without replacing history",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!, async (file) => {
      const config = JSON.parse(await readFile(file, "utf8"));
      config.providers["bigbud-v2-fixture-next"] = {
        ...config.providers["bigbud-v2-fixture"],
        models: {
          "second-model": {
            name: "second-model",
            limit: { context: 32000, output: 4000 },
            variants: [{ id: "precise", settings: { temperature: 0.1 } }],
          },
        },
      };
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    });
    try {
      const configBefore = await readFile(fixture.configFile);
      const registrationBefore = await readFile(fixture.file);
      const endpoint = (await readV2SharedRegistration(fixture.file)).endpoint;
      const client = makeV2Client({ endpoint: endpoint.url, headers: Service.headers(endpoint) });
      const settings = {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencodeV2: {
              enabled: true,
              binaryPath: "",
              profileRoot: "",
              serviceFile: fixture.file,
            },
          },
        }),
        streamChanges: Stream.never,
      } as unknown as typeof ServerSettingsService.Service;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registration = yield* makeV2ApplicationRegistration();
            const adapter = registration.adapterService;
            const send = vi.spyOn(adapter, "sendTurn");
            const start = vi.spyOn(adapter, "startSession");
            const directory = ProviderSessionDirectoryLive.pipe(
              Layer.provide(ProviderSessionRuntimeRepositoryLive),
              Layer.provide(SqlitePersistenceMemory),
            );
            const serviceLayer = makeProviderServiceLive({
              getProviderCapabilities: () => registration.capabilities,
            }).pipe(
              Layer.provide(Layer.succeed(ProviderAdapterRegistry, makeAdapterLookup([adapter]))),
              Layer.provide(directory),
              Layer.provide(Layer.succeed(ServerSettingsService, settings)),
              Layer.provide(AnalyticsService.layerTest),
            );
            yield* Effect.gen(function* () {
              const provider = yield* ProviderService;
              expect((yield* provider.getCapabilities("opencodeV2")).sessionModelSwitch).toBe(
                "in-session",
              );
              const h = makeSettingsHarness("opencodeV2");
              Object.assign(h.services, {
                providerService: provider,
                serverSettingsService: settings,
              });
              const selection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              h.updateThread({
                modelSelection: selection,
                worktreePath: fixture.workspace,
                executionTargetId: "local",
                workspaceExecutionTargetId: "local",
                providerRuntimeExecutionTargetId: "local",
              });
              const events: ProviderRuntimeEvent[] = [];
              yield* provider.streamEvents.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Effect.forkScoped,
              );
              yield* ensureSessionForThread(h.services)(threadId, createdAt);
              const nativeId = (
                (yield* provider.listSessions())[0]!.resumeCursor as { nativeSessionId: string }
              ).nativeSessionId;
              yield* sendTurnForThread(h.services)({
                threadId,
                createdAt,
                messageText: "delegated_thread_provenance: first synthetic routed turn",
                requestMessageId: MessageId.makeUnsafe("application-model-first"),
                modelSelection: selection,
              });
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () =>
                      new Set(
                        events
                          .filter((event) => event.type === "turn.completed")
                          .map((event) => event.turnId),
                      ).size,
                    {
                      timeout: 15000,
                    },
                  )
                  .toBe(1),
              );
              h.settle();
              const firstNative = yield* Effect.promise(() =>
                client.session.get({ sessionID: nativeId }),
              );
              expect(firstNative.model?.id).toBe("synthetic-model");
              // A development/server reload has no live adapter owner. Retained native history must rebind first.
              yield* adapter.stopSession(threadId);
              yield* sendTurnForThread(h.services)({
                threadId,
                createdAt,
                messageText: "delegated_thread_provenance: second synthetic routed turn",
                requestMessageId: MessageId.makeUnsafe("application-model-second"),
                modelSelection: {
                  provider: "opencodeV2",
                  subProviderID: "bigbud-v2-fixture-next",
                  model: "second-model",
                  options: { variant: "precise" },
                },
              });
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () =>
                      new Set(
                        events
                          .filter((event) => event.type === "turn.completed")
                          .map((event) => event.turnId),
                      ).size,
                    {
                      timeout: 15000,
                    },
                  )
                  .toBe(2),
              );
              const native = yield* Effect.promise(() =>
                client.session.get({ sessionID: nativeId }),
              );
              expect(native.model).toEqual({
                providerID: "bigbud-v2-fixture-next",
                id: "second-model",
                variant: "precise",
              });
              expect(native.metadata).toEqual(firstNative.metadata);
              expect(native.location).toEqual(firstNative.location);
              expect(start).toHaveBeenCalledTimes(2);
              const requestCount = fixture.state.modelRequests;
              const original = send.mock.calls[0]![0];
              const stale = yield* provider.sendTurn(original).pipe(Effect.result);
              expect(stale._tag).toBe("Failure");
              expect(fixture.state.modelRequests).toBe(requestCount);
              // Re-observing the new transport epoch must not change the durable original request/model.
              yield* provider.sendTurn({
                ...original,
                sessionEpoch: (yield* provider.listSessions())[0]!.sessionEpoch,
              });
              expect(fixture.state.modelRequests).toBe(requestCount);
              expect(
                (yield* Effect.promise(() => client.session.get({ sessionID: nativeId }))).model,
              ).toEqual(native.model);
              const history = yield* Effect.promise(() =>
                client.message.list({ sessionID: nativeId }),
              );
              expect(history.data.filter((message) => message.type === "user")).toHaveLength(2);
              // Original-request replay must not persist an obsolete startup model for a later reload.
              yield* adapter.stopSession(threadId);
              const rebound = yield* provider.startSession(threadId, {
                provider: "opencodeV2",
                threadId,
                cwd: fixture.workspace,
                modelSelection: selection,
                runtimeMode: "full-access",
              });
              expect(rebound.model).toBe("second-model");
              expect((rebound.resumeCursor as { nativeSessionId: string }).nativeSessionId).toBe(
                nativeId,
              );
              expect(fixture.state.modelRequests).toBe(requestCount);
              yield* provider.stopSession({ threadId });
            }).pipe(Effect.provide(serviceLayer));
          }),
        ).pipe(
          Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ServerConfig, {
            cwd: fixture.workspace,
            stateDir: path.join(fixture.profile, "bigbud-state"),
            port: 0,
          } as typeof ServerConfig.Service),
          Effect.provide(NodeServices.layer),
        ),
      );
      expect((await client.server.info()).version).toBe(version);
      expect((await client.server.info()).pid).toBe(fixture.child.pid);
      expect(await readFile(fixture.configFile)).toEqual(configBefore);
      expect(await readFile(fixture.file)).toEqual(registrationBefore);
    } finally {
      await fixture.close();
    }
  },
  60000,
);
