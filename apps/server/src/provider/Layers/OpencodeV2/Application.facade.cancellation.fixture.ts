import { Effect } from "effect";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { runAuthorizedV2 } from "./Client.guard.ts";
import { deferred } from "./Test.fixtures.ts";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";

export interface V2FacadeSyntheticWire {
  client: OpencodeV2Client;
  descriptor: { registrationFile: string; storageIdentity: string; generation: string };
  workspace: string;
  failure?: string;
}

/** Actual production registration, shared runtime, jobs, signed bootstrap and SQLite. Only
 * discovery/borrowed transport and native readiness/activity are disposable synthetic APIs. */
export async function withV2FacadeCancellationFixture(
  wire: V2FacadeSyntheticWire,
  run: (fixture: {
    registration: Effect.Success<ReturnType<typeof makeV2ApplicationRegistration>>;
    coordinator: V2ThreadToolsActivation;
    http: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["http"];
    base: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["runtime"];
    directory: string;
    entered: Promise<void>;
    pause: () => void;
    release: () => void;
    keeper: () => Promise<ReturnType<V2ThreadToolsActivation["requestSetup"]>>;
    job: () => V2OwnedActivationJob;
  }) => Promise<void>,
) {
  await withV2RuntimeFixture(async ({ runtime: base, http, directory: requested }) => {
    const directory = await realpath(requested);
    const app = await makeV2ThreadPluginFixture(),
      root = path.join(app.root, "owned-global"),
      entered = deferred<void>(),
      held = deferred<void>();
    await mkdir(root, { mode: 0o700 });
    wire.client = http.client;
    wire.workspace = directory;
    wire.descriptor = {
      registrationFile: path.join(app.root, "synthetic-registration.json"),
      storageIdentity: "synthetic-owned-history",
      generation: "synthetic-native-generation",
    };
    const host = makeV2ThreadPluginHost(app.bind("unrelated-bootstrap", directory));
    host.context.session.get = async ({ sessionID }) => {
      const native = http.sessions.get(sessionID);
      if (!native) throw new Error("Synthetic native session missing");
      return {
        ...native,
        metadata: native.metadata as {
          bigbud_provider: string;
          bigbud_thread: string;
          bigbud_storage: string;
        },
      };
    };
    let paused = false;
    http.client.rpc.call = async (input) => {
      if (paused && input.method === "info")
        throw new Error("V2 required bootstrap temporarily unavailable");
      try {
        return { output: await host.call(input.method, input.input) };
      } catch (error) {
        wire.failure =
          error instanceof Error
            ? (error.stack?.split("\n").slice(0, 6).join("\n") ?? error.message)
            : "unknown synthetic bootstrap failure";
        throw error;
      }
    };
    http.client.config.get = async () => [{ type: "directory", path: root }];
    http.client.plugin.list = async (input) => ({
      location: { directory: input?.location?.directory ?? directory },
      data: paused
        ? []
        : [
            {
              id: `bigbud.thread.v2.${app.artifact.issuer}`,
              source: { type: "local", path: app.artifact.directory },
              features: { server: true, rpc: true },
              state: { status: "active" },
            },
          ],
    });
    const dispose = await (await import(app.artifact.entryUri)).default.setup(host.context);
    const settings = await Effect.runPromise(
      makeTestSettings({
        providers: {
          opencodeV2: {
            enabled: true,
            connectionMode: "shared",
            binaryPath: "",
            profileRoot: "",
            serviceFile: wire.descriptor.registrationFile,
            nativeServiceTrust: "managed-thread-tools-v2",
            nativePluginConfigRoot: root,
          },
        },
      }),
    );
    const raw = makeV2SyntheticNativeEligibility(http.client, app.artifact, root);
    const coordinator = new V2ThreadToolsActivation(settings, async (...args) => ({
      ...(await raw(...args)),
      transport: wire.descriptor.registrationFile,
    }));
    let job: V2OwnedActivationJob | undefined;
    const target = coordinator as unknown as {
        activate: (job: V2OwnedActivationJob) => Promise<void>;
      },
      activate = target.activate.bind(coordinator);
    const observation = vi.spyOn(target, "activate").mockImplementation(async (owned) => {
      job = owned;
      owned.phase("waiting-for-idle");
      entered.resolve();
      await held.promise;
      owned.assertCurrent();
      await activate(owned);
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registration = yield* makeV2ApplicationRegistration();
            yield* Effect.promise(() =>
              run({
                registration,
                coordinator,
                http,
                base,
                directory,
                entered: entered.promise,
                pause: () => {
                  paused = true;
                },
                release: () => {
                  paused = false;
                  held.resolve();
                },
                job: () => job!,
                keeper: () =>
                  runAuthorizedV2(coordinator.consent, wire.descriptor.registrationFile, async () =>
                    coordinator.requestSetup(app.artifact, wire.descriptor, directory),
                  ),
              }),
            );
          }),
        ).pipe(
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ProviderTurnAdmissions, base.options.journal),
          Effect.provideService(OpencodeV2SharedBindings, base.options.sharedBindings!),
          Effect.provideService(ThreadToolsActivation, coordinator),
          Effect.provideService(ServerConfig, {
            stateDir: app.root,
            cwd: directory,
            port: 0,
            attachmentsDir: app.root,
          } as typeof ServerConfig.Service),
        ),
      );
    } finally {
      paused = false;
      held.resolve();
      observation.mockRestore();
      await coordinator.close();
      await dispose();
      await app.close();
    }
  });
}
