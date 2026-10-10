import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, PubSub, Stream } from "effect";
import { expect, it } from "vitest";
import {
  ThreadId,
  MessageId,
  ApprovalRequestId,
  DEFAULT_SERVER_SETTINGS,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
for (const action of ["interrupt", "stop", "disable"] as const) {
  it.skipIf(!binary || process.platform !== "darwin")(
    `normal pinned-native application ${action} cancels a running TERM-ignoring shell and waits for actual exit`,
    async () => {
      const fixture = await makeV2CodingNativeFixture();
      await writeFile(
        path.join(fixture.profile, ".bigbud-opencode-v2"),
        "bigbud-opencode-v2-owned-v1\n",
        { mode: 0o600 },
      );
      await writeFile(
        path.join(fixture.workspace, "hold.py"),
        "import signal,time,pathlib,os\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\npathlib.Path('native-ready').write_text(str(os.getpid()))\ntime.sleep(15)\npathlib.Path('native-late').write_text('unsafe')\n",
      );
      fixture.state.tool = "bigbud_shell";
      fixture.state.input = {
        command: "exec /Library/Developer/CommandLineTools/usr/bin/python3 -I -S hold.py",
      };
      let settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: {
            enabled: true,
            binaryPath: binary!,
            profileRoot: fixture.profile,
            connectionMode: "isolated" as const,
          },
        },
      };
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const changes = yield* PubSub.unbounded<typeof settings>();
              const service = {
                getSettings: Effect.sync(() => settings),
                streamChanges: Stream.fromPubSub(changes),
              } as unknown as typeof ServerSettingsService.Service;
              const registration = yield* makeV2ApplicationRegistration().pipe(
                Effect.provideService(ServerSettingsService, service),
              );
              const adapter = registration.adapterService,
                events: ProviderRuntimeEvent[] = [];
              yield* adapter.streamEvents.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Effect.forkScoped,
              );
              const threadId = ThreadId.makeUnsafe(`native-${action}`),
                modelSelection = {
                  provider: "opencodeV2",
                  subProviderID: "bigbud-v2-fixture",
                  model: "synthetic-model",
                } as const;
              yield* adapter.startSession({
                threadId,
                cwd: fixture.workspace,
                modelSelection,
                runtimeMode: "approval-required",
              });
              yield* adapter.sendTurn({
                threadId,
                modelSelection,
                requestMessageId: MessageId.makeUnsafe(`native-${action}`),
                input: "synthetic hold",
              });
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () =>
                      events.find(
                        (event) =>
                          event.type === "request.opened" &&
                          event.requestId?.startsWith("bbv2-code:"),
                      ),
                    { timeout: 15000 },
                  )
                  .toBeDefined(),
              );
              const approval = events.find(
                (event) =>
                  event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
              )!;
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.makeUnsafe(approval.requestId!),
                "accept",
              );
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () =>
                      readFile(path.join(fixture.workspace, "native-ready"), "utf8").catch(
                        () => "",
                      ),
                    { timeout: 10000 },
                  )
                  .not.toBe(""),
              );
              const pid = Number(
                yield* Effect.promise(() =>
                  readFile(path.join(fixture.workspace, "native-ready"), "utf8"),
                ),
              );
              expect(() => process.kill(pid, 0)).not.toThrow();
              if (action === "interrupt") yield* adapter.interruptTurn(threadId);
              else if (action === "stop") yield* adapter.stopSession(threadId);
              else {
                settings = {
                  ...settings,
                  providers: {
                    ...settings.providers,
                    opencodeV2: { ...settings.providers.opencodeV2, enabled: false },
                  },
                };
                yield* PubSub.publish(changes, settings);
                yield* Effect.promise(() =>
                  expect
                    .poll(
                      () => {
                        try {
                          process.kill(pid, 0);
                          return true;
                        } catch {
                          return false;
                        }
                      },
                      { timeout: 10000 },
                    )
                    .toBe(false),
                );
                yield* registration.providerService.refresh;
              }
              expect(() => process.kill(pid, 0)).toThrow();
              yield* Effect.promise(() =>
                expect(readFile(path.join(fixture.workspace, "native-late"))).rejects.toThrow(),
              );
              yield* adapter.stopAll();
            }).pipe(
              Effect.provide(
                ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory)),
              ),
            ),
          ),
        );
      } finally {
        await fixture.close();
      }
    },
    45000,
  );
}
