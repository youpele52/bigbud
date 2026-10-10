import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
  ApprovalRequestId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  MessageId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { makeV2NativeDelegationFixture } from "./Execution.delegation.fixture.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { readThreadOrchestrationToolAuth } from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary || process.platform !== "darwin")(
  "normal pinned-native application executes approved contained shell and independent canonical child with truthful supervised tools",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    await writeFile(
      path.join(fixture.profile, ".bigbud-opencode-v2"),
      "bigbud-opencode-v2-owned-v1\n",
      { mode: 0o600 },
    );
    fixture.state.textOnlyDelegated = true;
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
            const threadId = ThreadId.makeUnsafe("native-execution-tools");
            const delegation = yield* makeV2NativeDelegationFixture({
              profile: fixture.profile,
              workspace: fixture.workspace,
              parent: threadId,
            });
            const journal = yield* ProviderTurnAdmissions;
            const registration = yield* makeV2ApplicationRegistration().pipe(
                Effect.provideService(ServerConfig, {
                  stateDir: fixture.profile,
                  attachmentsDir: path.join(fixture.profile, "attachments"),
                  port: delegation.port,
                } as typeof ServerConfig.Service),
              ),
              adapter = registration.adapterService;
            delegation.bind(adapter);
            const events: ProviderRuntimeEvent[] = [];
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
              ),
              Effect.forkScoped,
            );
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
            for (const action of ["shell", "orchestration"] as const) {
              fixture.state.tool = `bigbud_${action}`;
              fixture.state.input =
                action === "shell"
                  ? { command: "printf 'contained native execution' > executed.txt" }
                  : {
                      request: {
                        action: "create_thread",
                        title: "Native requested child",
                        task: "Separate canonical task",
                        watchForCompletion: true,
                      },
                    };
              const offset = events.length;
              yield* adapter.sendTurn({
                threadId,
                modelSelection,
                requestMessageId: MessageId.makeUnsafe(`native-${action}`),
                input: "synthetic canonical execution",
              });
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () =>
                      events
                        .slice(offset)
                        .find(
                          (event) =>
                            event.type === "request.opened" &&
                            event.requestId?.startsWith("bbv2-code:"),
                        ),
                    { timeout: 15000 },
                  )
                  .toBeDefined(),
              );
              const request = events
                .slice(offset)
                .find(
                  (event) =>
                    event.type === "request.opened" && event.requestId?.startsWith("bbv2-code:"),
                )!;
              if (request.type !== "request.opened") throw new Error("approval missing");
              expect(request.payload.requestType).toBe("command_execution_approval");
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.makeUnsafe(request.requestId!),
                "accept",
              );
              yield* Effect.promise(() =>
                expect
                  .poll(
                    () => events.slice(offset).some((event) => event.type === "turn.completed"),
                    { timeout: 15000 },
                  )
                  .toBe(true),
              );
            }
            expect(
              yield* Effect.promise(() =>
                readFile(path.join(fixture.workspace, "executed.txt"), "utf8"),
              ),
            ).toBe("contained native execution");
            expect(delegation.dispatched).toHaveLength(1);
            const invocation = delegation.dispatched[0]!;
            expect(invocation.invocationId).toMatch(/^v2-tool:/);
            const readModel = yield* Effect.promise(() =>
              delegation.run(delegation.engine.getReadModel()),
            );
            const child = readModel.threads.find((thread) => thread.id !== threadId)!;
            expect(child).toMatchObject({
              modelSelection,
              runtimeMode: "approval-required",
              providerRuntimeExecutionTargetId: "local",
              workspaceExecutionTargetId: "local",
            });
            yield* Effect.promise(() =>
              expect
                .poll(
                  () =>
                    events.some(
                      (event) => event.threadId === child.id && event.type === "turn.completed",
                    ),
                  { timeout: 15000 },
                )
                .toBe(true),
            );
            const admissions = yield* journal.listBound(child.id, 10);
            expect(admissions).toHaveLength(1);
            expect(admissions[0]).toMatchObject({ state: "terminal" });
            const parentSession = (yield* adapter.listSessions()).find(
              (session) => session.threadId === threadId,
            )!;
            const childSession = (yield* adapter.listSessions()).find(
              (session) => session.threadId === child.id,
            )!;
            expect(parentSession).toBeDefined();
            expect(childSession).toBeDefined();
            expect(childSession).not.toEqual(parentSession);
            // Replay through the same authenticated real route before parent teardown.
            const auth = yield* Effect.promise(() =>
              readThreadOrchestrationToolAuth({ stateDir: fixture.profile, threadId }),
            );
            const replayResponse = yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${delegation.port}/api/internal/thread-tools`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-bigbud-thread-tool-token": auth!.token,
                },
                body: JSON.stringify({ ...invocation, action: "create_thread" }),
              }),
            );
            expect(replayResponse.status).toBe(200);
            expect(yield* Effect.promise(() => replayResponse.json())).toMatchObject({
              result: { replayed: true, childThreadId: child.id },
            });
            expect(yield* journal.listBound(child.id, 10)).toHaveLength(1);
            expect(
              (yield* Effect.promise(() => delegation.run(delegation.engine.getReadModel())))
                .threads,
            ).toHaveLength(2);
            yield* adapter.stopSession(threadId);
            const childOffset = events.length;
            yield* adapter.sendTurn({
              threadId: child.id,
              modelSelection,
              requestMessageId: MessageId.makeUnsafe("child-after-parent-stop"),
              input: "Independent child continues",
            });
            yield* Effect.promise(() =>
              expect
                .poll(
                  () =>
                    events
                      .slice(childOffset)
                      .some(
                        (event) => event.threadId === child.id && event.type === "turn.completed",
                      ),
                  { timeout: 15000 },
                )
                .toBe(true),
            );
            expect(yield* journal.listBound(child.id, 10)).toHaveLength(2);
            // Co-located Supervised native tools are available behind explicit approvals, not hidden/contained.
            for (const builtin of ["shell", "read", "write", "edit", "skill"])
              expect(fixture.state.advertised.has(builtin)).toBe(true);
            expect(fixture.state.advertised.has("subagent")).toBe(false);
            expect(fixture.state.advertised.has("bigbud_shell")).toBe(true);
            expect(fixture.state.advertised.has("bigbud_orchestration")).toBe(true);
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
  60000,
);
