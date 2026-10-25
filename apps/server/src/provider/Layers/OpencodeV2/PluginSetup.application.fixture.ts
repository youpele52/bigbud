import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeOwnedClient } from "./Client.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { v2NativeCandidateFixtureVerifier } from "./NativeCompatibility.candidate.fixture.ts";

type Fixture = {
  app: Awaited<ReturnType<typeof makeV2ThreadPluginFixture>>;
  native: Awaited<ReturnType<typeof sharedServiceNativeFixture>>;
  settings: Effect.Success<ReturnType<typeof makeTestSettings>>;
  registration: Effect.Success<ReturnType<typeof makeV2ApplicationRegistration>>;
  client: ReturnType<typeof makeOwnedClient>;
  configRoot: string;
};

/** Production composition over an exclusively owned native service and disposable global configuration. */
export async function withV2AutomaticSetupApplication(
  binary: string,
  run: (fixture: Fixture) => Promise<void>,
  prepareConfig?: (filename: string) => Promise<void>,
) {
  const app = await makeV2ThreadPluginFixture();
  const native = await sharedServiceNativeFixture(binary, prepareConfig).catch(async (error) => {
    await app.close();
    throw error;
  });
  try {
    const configRoot = path.dirname(native.configFile);
    const settings = await Effect.runPromise(
      makeTestSettings({
        ...DEFAULT_SERVER_SETTINGS,
        defaultChatCwd: native.workspace,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: {
            enabled: true,
            binaryPath: "",
            profileRoot: "",
            connectionMode: "shared",
            serviceFile: native.file,
            nativeServiceTrust: "managed-thread-tools-v2",
            nativePluginConfigRoot: configRoot,
          },
        },
      }),
    );
    const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
    const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
    const eligibility = v2NativeCandidateFixtureVerifier(
      native,
      client,
      "PluginSetup.application.native",
    );
    const persistence = Layer.merge(ProviderTurnAdmissionsLive, OpencodeV2SharedBindingsLive).pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* makeV2ApplicationRegistration(eligibility);
          yield* Effect.promise(() =>
            run({ app, native, settings, registration, client, configRoot }),
          );
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(persistence, NodeServices.layer)),
        Effect.provideService(ServerSettingsService, settings),
        Effect.provideService(ServerConfig, {
          stateDir: app.root,
          cwd: native.workspace,
          port: 0,
          attachmentsDir: app.root,
        } as typeof ServerConfig.Service),
      ),
    );
  } finally {
    await native.close();
    await app.close();
  }
}
