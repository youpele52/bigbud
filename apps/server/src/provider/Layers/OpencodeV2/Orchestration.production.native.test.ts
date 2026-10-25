import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_SERVER_SETTINGS, MessageId, ThreadId } from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { makeV2NativeDelegationFixture } from "./Execution.delegation.fixture.ts";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeOwnedClient } from "./Client.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { isThreadTitleLocked } from "../../../orchestration-tools/ThreadTitleLock.ts";
import { v2NativeCandidateFixtureVerifier } from "./NativeCompatibility.candidate.fixture.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

it.skipIf(!binary)(
  "owned native executors use production composition/callback/journal to dispatch actual canonical HTTP/SQLite operations",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const native = await sharedServiceNativeFixture(binary!).catch(async (error) => {
      await app.close();
      throw error;
    });
    const parent = ThreadId.makeUnsafe("native-production-source");
    const target = ThreadId.makeUnsafe("native-other-provider-target");
    try {
      const before = await readFile(native.configFile);
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      const eligibility = v2NativeCandidateFixtureVerifier(
        native,
        client,
        "Orchestration.production.native",
      );
      expect((await client.server.info()).pid).toBe(native.child.pid);
      const settings = await Effect.runPromise(
        makeTestSettings({
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencodeV2: {
              enabled: true,
              binaryPath: "",
              profileRoot: "",
              connectionMode: "shared",
              serviceFile: native.file,
              nativeServiceTrust: "managed-thread-tools-v2",
              nativePluginConfigRoot: path.dirname(native.configFile),
            },
          },
        }),
      );
      const persistence = Layer.merge(
        ProviderTurnAdmissionsLive,
        OpencodeV2SharedBindingsLive,
      ).pipe(Layer.provide(SqlitePersistenceMemory));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const canonical = yield* makeV2NativeDelegationFixture({
              profile: app.root,
              workspace: native.workspace,
              parent,
              runtimeMode: "full-access",
            });
            const config = {
              stateDir: app.root,
              cwd: native.workspace,
              port: canonical.port,
              attachmentsDir: app.root,
            } as typeof ServerConfig.Service;
            const registration = yield* makeV2ApplicationRegistration(eligibility).pipe(
              Effect.provideService(ServerConfig, config),
            );
            const adapter = registration.adapterService;
            canonical.bind(adapter);
            const parentThread = (yield* Effect.promise(() =>
              canonical.run(canonical.engine.getReadModel()),
            )).threads.find((thread) => thread.id === parent)!;
            yield* Effect.promise(() =>
              canonical.run(
                canonical.engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.makeUnsafe("native-target"),
                  threadId: target,
                  projectId: parentThread.projectId,
                  title: "Other provider",
                  modelSelection: { provider: "codex", model: "independent-native-test" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  providerRuntimeExecutionTargetId: "local",
                  workspaceExecutionTargetId: "local",
                  executionTargetId: "local",
                  branch: null,
                  worktreePath: null,
                  createdAt: new Date().toISOString(),
                }),
              ),
            );
            yield* adapter.startSession({
              threadId: parent,
              cwd: native.workspace,
              modelSelection: canonical.selection,
              runtimeMode: "full-access",
            });
            const cases = [
              {
                action: "send_thread_message",
                input: { threadId: target, message: "native canonical smile" },
              },
              {
                action: "create_thread",
                input: {
                  title: "Native canonical child",
                  task: "Independent synthetic canonical task",
                },
              },
              { action: "get_thread_status", input: { threadId: target } },
              { action: "list_threads", input: {} },
              {
                action: "rename_thread",
                input: { title: "Canonically renamed native target", targetThreadId: target },
              },
            ];
            for (const [index, item] of cases.entries()) {
              native.state.tool = `bigbud_thread_v1_${item.action}`;
              native.state.input = item.input;
              yield* adapter.sendTurn({
                threadId: parent,
                input: `Synthetic production ${item.action}`,
                requestMessageId: MessageId.makeUnsafe(`native-production-${index}`),
              });
              const session = (yield* adapter.listSessions()).find(
                (session) => session.threadId === parent,
              )!;
              const id = (session.resumeCursor as { nativeSessionId: string }).nativeSessionId;
              yield* Effect.promise(() =>
                client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(10000) }),
              );
              yield* Effect.promise(() =>
                expect
                  .poll(
                    async () =>
                      (await client.message.list({ sessionID: id })).data.some(
                        (message) =>
                          message.type === "assistant" &&
                          message.content.some(
                            (part) =>
                              part.type === "tool" &&
                              part.name === native.state.tool &&
                              part.state.status === "completed",
                          ),
                      ),
                    { timeout: 10000 },
                  )
                  .toBe(true),
              );
              yield* Effect.promise(() =>
                expect
                  .poll(
                    async () =>
                      (await Effect.runPromise(adapter.listSessions())).find(
                        (session) => session.threadId === parent,
                      )?.status,
                    { timeout: 10000 },
                  )
                  .toBe("ready"),
              );
            }
            const read = yield* Effect.promise(() =>
              canonical.run(canonical.engine.getReadModel()),
            );
            const sent = read.threads.find((thread) => thread.id === target)!;
            expect(
              sent.messages.filter((message) => message.text === "native canonical smile"),
            ).toHaveLength(1);
            expect(sent.modelSelection).toEqual({
              provider: "codex",
              model: "independent-native-test",
            });
            expect(sent.title).toBe("Canonically renamed native target");
            expect(isThreadTitleLocked(target)).toBe(true);
            const child = read.threads.find((thread) => thread.title === "Native canonical child")!;
            expect(child.modelSelection).toEqual(canonical.selection);
            expect(child.id).not.toBe(parent);
            expect(yield* adapter.hasSession(child.id)).toBe(true);
            const priorRequests = native.state.requests.length;
            expect(
              yield* adapter.runBackgroundReview!({
                ownerThreadId: parent,
                jobId: "hidden-no-tools",
                modelSelection: canonical.selection,
                cwd: native.workspace,
                input: "Synthetic hidden review: text only, no canonical tools.",
              }),
            ).toContain("synthetic");
            expect(
              native.state.requests
                .slice(priorRequests)
                .every((request) => !JSON.stringify(request).includes("bigbud_thread_v1_")),
            ).toBe(true);
            yield* adapter.stopSession(parent);
            expect(yield* adapter.hasSession(child.id)).toBe(true);
            expect(
              (yield* Effect.promise(() =>
                canonical.run(canonical.engine.getReadModel()),
              )).threads.find((thread) => thread.id === child.id)?.deletedAt,
            ).toBe(null);
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(persistence, NodeServices.layer)),
          Effect.provideService(ServerSettingsService, settings),
        ),
      );
      expect(await readFile(native.configFile)).toEqual(before);
      expect(
        await readFile(
          path.join(path.dirname(native.configFile), "plugins", "bigbud-thread-tools-managed.js"),
          "utf8",
        ),
      ).toContain(app.artifact.entryUri);
    } finally {
      await native.close();
      await app.close();
    }
  },
  60000,
);
