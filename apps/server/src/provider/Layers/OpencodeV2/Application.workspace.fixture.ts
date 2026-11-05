import { realpath } from "node:fs/promises";
import { Effect, Layer, Option } from "effect";
import { expect, vi } from "vitest";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { makeV2SharedTargetPreparation } from "./Application.targets.shared.ts";
import { makeProviderServiceLive } from "../ProviderService.ts";
import { ProviderService } from "../../Services/ProviderService.ts";
import { ProviderAdapterRegistry } from "../../Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { sendTurnForThread } from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.ts";
import {
  makeSettingsHarness,
  threadId,
  createdAt,
} from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.settings.test.helpers.ts";

export { threadId, createdAt };
export const workspaceModel = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

/** Real reactor -> ProviderService/SQLite -> V2 runtime; controlled read model and synthetic native/remote edges. */
export async function withWorkspaceApp(
  remote: boolean,
  run: (h: Awaited<ReturnType<typeof workspaceHarness>>) => Promise<void>,
) {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory: localCwd }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const catalogs = new Map<string, string>();
          vi.spyOn(http.client.mcp, "add").mockImplementation(async ({ location, server }) => {
            catalogs.set(location!.directory!, server);
          });
          vi.spyOn(http.client.mcp, "list").mockImplementation(async ({ location } = {}) => ({
            location: { directory: location!.directory! },
            data: catalogs.has(location!.directory!)
              ? [{ name: catalogs.get(location!.directory!)!, status: { status: "connected" } }]
              : [],
          }));
          const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: remote };
          const executing = yield* makeV2RuntimeAdapter({
            ...options,
            prepareSession: makeV2SharedTargetPreparation(
              options,
              baseline.options.config.profileRoot,
              12345,
            ),
          });
          const directoryLayer = ProviderSessionDirectoryLive.pipe(
            Layer.provide(
              ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
            ),
          );
          const serviceLayer = makeProviderServiceLive({
            getProviderCapabilities: () => ({
              supportsRemoteProviderRuntime: false,
              supportsLocalRuntimeRemoteWorkspace: true,
              toolInjectionMode: "mcp",
              needsBuiltinsDisabled: true,
            }),
          }).pipe(
            Layer.provide(
              Layer.succeed(ProviderAdapterRegistry, {
                getByProvider: () => Effect.succeed(executing.adapter),
                listProviders: () => Effect.succeed(["opencodeV2"]),
              }),
            ),
            Layer.provide(directoryLayer),
            Layer.provide(
              ServerSettingsService.layerTest({ providers: { opencodeV2: { enabled: true } } }),
            ),
            Layer.provide(AnalyticsService.layerTest),
          );
          yield* Effect.gen(function* () {
            const provider = yield* ProviderService;
            const directory = yield* ProviderSessionDirectory;
            const h = yield* Effect.promise(() =>
              workspaceHarness({
                remote,
                provider,
                directory,
                executing,
                http,
                localCwd,
                stateDir: baseline.options.config.profileRoot,
              }),
            );
            yield* Effect.promise(() => run(h));
          }).pipe(Effect.provide(Layer.merge(serviceLayer, directoryLayer)));
        }),
      ),
    );
  });
}

async function workspaceHarness(input: {
  remote: boolean;
  provider: typeof ProviderService.Service;
  directory: typeof ProviderSessionDirectory.Service;
  executing: Effect.Success<ReturnType<typeof makeV2RuntimeAdapter>>;
  http: import("./Runtime.fixture.ts").V2RuntimeHttpFixture;
  localCwd: string;
  stateDir: string;
}) {
  const { provider, directory, executing, http } = input;
  const base = makeSettingsHarness("opencodeV2");
  const cwd = input.remote ? "/srv/vps-project-not-on-backend" : await realpath(input.localCwd);
  const target = input.remote ? "ssh:vps" : "local";
  base.updateThread({
    modelSelection: workspaceModel,
    workspaceExecutionTargetId: target,
    executionTargetId: target,
  });
  const project = {
    id: base.thread.projectId,
    workspaceRoot: cwd,
    title: "Workspace fixture",
    defaultModelSelection: workspaceModel,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletingAt: null,
  };
  const services = {
    ...base.services,
    providerService: provider,
    serverConfig: { ...base.services.serverConfig, stateDir: input.stateDir },
    orchestrationEngine: {
      ...base.services.orchestrationEngine,
      getReadModel: () =>
        Effect.succeed({
          snapshotSequence: 0,
          threads: [base.thread],
          projects: [project],
          updatedAt: createdAt,
        }),
    },
  } satisfies typeof base.services;
  const send = async (id: string) => {
    await Effect.runPromise(
      sendTurnForThread(services)({
        threadId,
        requestMessageId: MessageId.makeUnsafe(id),
        messageText: id,
        createdAt,
      }),
    );
    await expect.poll(() => executing.runtime.get(threadId).terminalDelivered).toBe(true);
    base.settle();
  };
  const binding = async () =>
    Option.getOrThrow(await Effect.runPromise(directory.getBinding(threadId)));
  return {
    updateThread: base.updateThread,
    services,
    project,
    cwd,
    target,
    send,
    binding,
    provider,
    directory,
    ...executing,
    http,
    start: vi.spyOn(executing.adapter, "startSession"),
    prompts: () => http.calls.filter((call) => call.pathname.endsWith("/prompt")),
    creations: () =>
      http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
  };
}
