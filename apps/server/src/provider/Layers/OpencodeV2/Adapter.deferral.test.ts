import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import type { V2OwnedActivationJob, V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";
import type { OpencodeV2Client } from "./Client.ts";

const wire = vi.hoisted(() => ({
  client: undefined as unknown as OpencodeV2Client,
  close: vi.fn(async () => {}),
}));
vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => ({ client: wire.client, close: wire.close }),
}));
vi.mock("./Orchestration.readiness.ts", () => ({
  verifyV2ThreadTools: async () => {
    throw new Error("V2 required bootstrap not yet installed");
  },
}));
vi.mock("./Orchestration.readiness.manual.ts", () => ({
  readV2CompatibleManualBootstrap: async () => undefined,
}));

it.each(["completion", "revocation"] as const)(
  "actual adapter startup deferral keeps a separately owned continuation through %s but never replays startup",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await withV2RuntimeFixture(async ({ runtime: base, http, directory }) => {
      const f = await makeV2ActivationJobsFixture(),
        app = await makeV2ThreadPluginFixture(),
        entered = deferred<void>(),
        idle = deferred<void>(),
        closed = deferred<void>();
      wire.client = http.client;
      wire.close.mockClear();
      wire.close.mockImplementation(async () => {
        closed.resolve();
      });
      await Effect.runPromise(
        f.settings.updateSettings({
          providers: { opencodeV2: { nativePluginConfigRoot: directory } },
        }),
      );
      const coordinator = new V2ThreadToolsActivation(f.settings),
        descriptor = {
          registrationFile: "owned-fixture",
          generation: "owned-generation",
          storageIdentity: "owned-storage",
        };
      let job: V2OwnedActivationJob | undefined;
      // Synthetic activity, not a mocked adapter/runtime or replacement job registry. The real
      // awaitReady→jobs.wait→adapter failure finalizer cascade is the behavior under test.
      const observer = vi
        .spyOn(
          coordinator as unknown as { activate: (job: V2OwnedActivationJob) => Promise<void> },
          "activate",
        )
        .mockImplementation(async (owned) => {
          job = owned;
          owned.phase("waiting-for-idle");
          entered.resolve();
          await idle.promise;
          owned.assertCurrent();
          owned.installed(app.artifact.artifactDigest);
        });
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { adapter, runtime } = yield* makeV2RuntimeAdapter({
                ...base.options,
                enableLocalTools: true,
                config: { sharedService: descriptor, runtimeTargetId: "local" },
                consent: coordinator.consent,
                threadToolsPreflight: (_client, cwd, signal) =>
                  coordinator
                    .awaitReady(app.artifact, descriptor, http.client, cwd, signal)
                    .then(() => {}),
              });
              const start = Effect.runPromise(
                Effect.exit(
                  adapter.startSession({
                    threadId: ThreadId.makeUnsafe("normally-deferred-start"),
                    cwd: directory,
                    modelSelection: {
                      provider: "opencodeV2",
                      subProviderID: "synthetic-provider",
                      model: "synthetic-model",
                    },
                    runtimeMode: "full-access",
                  }),
                ),
              );
              yield* Effect.promise(() =>
                Promise.race([
                  entered.promise,
                  start.then(() => {
                    throw new Error("Adapter exited before the real setup job started");
                  }),
                ]),
              );
              yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30000));
              yield* Effect.promise(async () => {
                expect((await start)._tag).toBe("Failure");
                expect(job!.signal.aborted).toBe(false);
                expect(wire.close).not.toHaveBeenCalled();
                expect(runtime.sessions.size).toBe(0);
                expect(
                  http.calls.filter(
                    (call) => call.method === "POST" && call.pathname === "/api/session",
                  ),
                ).toHaveLength(0);
                expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
                  0,
                );
                if (outcome === "revocation") {
                  await Effect.runPromise(
                    f.settings.updateSettings({ providers: { opencodeV2: { enabled: false } } }),
                  );
                  expect(job!.signal.aborted).toBe(true);
                }
                idle.resolve();
                const scope = {
                  root: directory,
                  issuer: app.artifact.issuer,
                  registrationId: `bigbud.thread.v2.${app.artifact.issuer}`,
                  transport: descriptor.registrationFile,
                  generation: descriptor.generation,
                  consentRevision: coordinator.consent.currentRevision(),
                  digest: app.artifact.artifactDigest,
                  descriptor,
                } satisfies V2ActivationJobScope;
                await closed.promise;
                if (outcome === "completion")
                  expect(coordinator.jobs.status(job!.id, scope).state).toBe("ready");
                expect(wire.close).toHaveBeenCalledTimes(1);
                expect(runtime.sessions.size).toBe(0);
                expect(http.sessions.size).toBe(0);
              });
            }),
          ),
        );
      } finally {
        idle.resolve();
        observer.mockRestore();
        await coordinator.close();
        f.consent.close();
        await app.close();
      }
    }).finally(() => vi.useRealTimers());
  },
);
