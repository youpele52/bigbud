import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
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
import { ServerConfig } from "../../../startup/config.ts";
import * as RemoteDefaults from "../../../remote-agent/remoteAgentDefault.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { makeV2RemoteAgentFixture } from "./Remote.fixture.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary)(
  "normal application routes local native execution to remote-agent files with mediated tools and staged references",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    await writeFile(
      path.join(fixture.profile, ".bigbud-opencode-v2"),
      "bigbud-opencode-v2-owned-v1\n",
      { mode: 0o600 },
    );
    await writeFile(path.join(fixture.workspace, "code.txt"), "original TARGET end");
    fixture.state.tool = "bigbud_edit";
    fixture.state.input = { path: "code.txt", oldText: "TARGET", newText: "remote literal $&" };
    const agent = await makeV2RemoteAgentFixture(fixture.workspace, fixture.profile);
    const composition = vi
      .spyOn(RemoteDefaults, "getConfiguredRemoteAgentComposition")
      .mockReturnValue({
        pool: { getWorkspaceClient: async () => agent.client },
      } as unknown as NonNullable<
        ReturnType<typeof RemoteDefaults.getConfiguredRemoteAgentComposition>
      >);
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
            expect(registration.capabilities.supportsLocalRuntimeRemoteWorkspace).toBe(true);
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
            const threadId = ThreadId.makeUnsafe("native-remote-application"),
              target = "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key&transport=agent";
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
              providerRuntimeExecutionTargetId: "local",
              workspaceExecutionTargetId: target,
            });
            yield* adapter.sendTurn({
              threadId,
              modelSelection,
              requestMessageId: MessageId.makeUnsafe("native-remote-application-message"),
              input: "synthetic actual remote coding",
              attachments: [
                {
                  type: "path",
                  id: "remote-source",
                  path: path.join(fixture.workspace, "code.txt"),
                  name: "code.txt",
                  entryKind: "file",
                  mimeType: "text/plain",
                  sizeBytes: 0,
                },
              ],
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
            if (approval.type !== "request.opened") throw new Error("approval missing");
            expect(approval.payload.args).toMatchObject({
              executionTargetId: target,
              path: path.join(fixture.workspace, "code.txt"),
            });
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.makeUnsafe(approval.requestId!),
              "accept",
            );
            yield* Effect.promise(() =>
              expect
                .poll(() => events.some((event) => event.type === "turn.completed"), {
                  timeout: 15000,
                })
                .toBe(true),
            );
            expect(
              yield* Effect.promise(() =>
                readFile(path.join(fixture.workspace, "code.txt"), "utf8"),
              ),
            ).toBe("original remote literal $& end");
            expect(fixture.state.advertised.has("bigbud_edit")).toBe(true);
            for (const builtin of ["shell", "read", "write", "edit", "skill", "subagent"])
              expect(fixture.state.advertised.has(builtin)).toBe(false);
            yield* adapter.stopAll();
          }).pipe(
            Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed(settings),
              streamChanges: Stream.empty,
            } as unknown as typeof ServerSettingsService.Service),
            Effect.provideService(ServerConfig, {
              stateDir: fixture.profile,
              attachmentsDir: path.join(fixture.profile, "attachments"),
            } as typeof ServerConfig.Service),
          ),
        ),
      );
    } finally {
      composition.mockRestore();
      await fixture.close();
    }
  },
  60000,
);
