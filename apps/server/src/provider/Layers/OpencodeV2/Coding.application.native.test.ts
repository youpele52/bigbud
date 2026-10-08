import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
  ApprovalRequestId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary)(
  "normal visible settings-driven application provider performs actual approval-mediated file coding with pinned native CLI",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    await writeFile(
      path.join(fixture.profile, ".bigbud-opencode-v2"),
      "bigbud-opencode-v2-owned-v1\n",
      { mode: 0o600 },
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: { enabled: true, binaryPath: binary!, profileRoot: fixture.profile },
      },
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registration = yield* makeV2ApplicationRegistration();
            const status = yield* registration.providerService.refresh;
            expect(status).toMatchObject({
              provider: "opencodeV2",
              enabled: true,
              installed: true,
            });
            const adapter = registration.adapterService;
            const events: ProviderRuntimeEvent[] = [];
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
              ),
              Effect.forkScoped,
            );
            const threadId = ThreadId.makeUnsafe("coding-application-native");
            const modelSelection = {
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
              requestMessageId: MessageId.makeUnsafe("coding-application-message"),
              input: "synthetic normal application coding",
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
                  { timeout: 15_000 },
                )
                .toBeDefined(),
            );
            const request = events.find(
              (event) =>
                event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
            )!;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.makeUnsafe(request.requestId!),
              "accept",
            );
            yield* Effect.promise(() =>
              expect
                .poll(() => events.some((event) => event.type === "turn.completed"), {
                  timeout: 15_000,
                })
                .toBe(true),
            );
            expect(
              yield* Effect.promise(() =>
                readFile(path.join(fixture.workspace, "main.py"), "utf8"),
              ),
            ).toBe("value = 1\n");
            expect(fixture.state.advertised.has("bigbud_write")).toBe(true);
            yield* adapter.stopAll();
          }).pipe(
            Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed(settings),
              streamChanges: Stream.empty,
            } as unknown as typeof ServerSettingsService.Service),
          ),
        ),
      );
    } finally {
      await fixture.close();
    }
  },
  60_000,
);
