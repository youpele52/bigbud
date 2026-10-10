import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
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
for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
  it.skipIf(!binary)(
    `normal pinned application ${mode} executes its actual policy, including native pipelines only with the appropriate trust`,
    async () => {
      const fixture = await makeV2CodingNativeFixture(mode === "full-access" ? 4000000 : 32000);
      await writeFile(
        path.join(fixture.profile, ".bigbud-opencode-v2"),
        "bigbud-opencode-v2-owned-v1\n",
        { mode: 0o600 },
      );
      fixture.state.tool = mode === "auto-accept-edits" ? "bigbud_write" : "shell";
      fixture.state.input =
        mode === "auto-accept-edits"
          ? { path: "result.txt", content: "AUTOMATIC BOUNDED EDIT" }
          : {
              command: "printf 'trusted native pipeline' | tr a-z A-Z > result.txt",
              description: "Exact approved pipeline",
              timeout: 5000,
            };
      const settings = {
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
              const registration = yield* makeV2ApplicationRegistration(),
                adapter = registration.adapterService;
              const events: ProviderRuntimeEvent[] = [];
              yield* adapter.streamEvents.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Effect.forkScoped,
              );
              const threadId = ThreadId.makeUnsafe(`native-access-${mode}`),
                modelSelection = {
                  provider: "opencodeV2",
                  subProviderID: "bigbud-v2-fixture",
                  model: "synthetic-model",
                } as const;
              yield* adapter.startSession({
                threadId,
                cwd: fixture.workspace,
                modelSelection,
                runtimeMode: mode,
              });
              yield* adapter.sendTurn({
                threadId,
                modelSelection,
                requestMessageId: MessageId.makeUnsafe(`mode-${mode}`),
                input: "synthetic action",
              });
              if (mode === "approval-required") {
                yield* Effect.promise(() =>
                  expect
                    .poll(() => events.find((event) => event.type === "request.opened"), {
                      timeout: 15000,
                    })
                    .toBeDefined(),
                );
                const opened = events.find((event) => event.type === "request.opened")!;
                if (opened.type !== "request.opened") throw new Error("approval missing");
                expect(opened.payload.executionIntent?.content).toContain("shell");
                expect(opened.payload.executionIntent?.content).toContain("printf");
                yield* adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.makeUnsafe(opened.requestId!),
                  "accept",
                );
              }
              yield* Effect.promise(() =>
                expect
                  .poll(() => events.some((event) => event.type === "turn.completed"), {
                    timeout: 15000,
                  })
                  .toBe(true),
              );
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(fixture.workspace, "result.txt"), "utf8"),
                ),
              ).toBe(
                mode === "auto-accept-edits" ? "AUTOMATIC BOUNDED EDIT" : "TRUSTED NATIVE PIPELINE",
              );
              if (mode !== "approval-required")
                expect(events.some((event) => event.type === "request.opened")).toBe(false);
              expect(fixture.state.advertised.has("shell")).toBe(true);
              expect(fixture.state.advertised.has("subagent")).toBe(false);
              if (mode === "full-access") {
                const request = {
                  ownerThreadId: threadId,
                  jobId: "native-application-review",
                  cwd: fixture.workspace,
                  input: "Disposable hidden review",
                  modelSelection,
                };
                const result = yield* adapter.runBackgroundReview!(request);
                expect(result).toBe("synthetic coding completed");
                const generated = fixture.state.modelRequests;
                expect(yield* adapter.runBackgroundReview!(request)).toBe(result);
                expect(fixture.state.modelRequests).toBe(generated);
                expect(
                  (yield* adapter.listSessions())
                    .filter((session) => session.status !== "closed")
                    .map((session) => session.threadId),
                ).toContain(threadId);
              }
              yield* adapter.stopAll();
            }).pipe(
              Effect.provide(
                ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory)),
              ),
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
    45000,
  );
}
