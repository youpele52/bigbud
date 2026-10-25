import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ApprovalRequestId,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
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
import { v2NativeCandidateFixtureVerifier } from "./NativeCompatibility.candidate.fixture.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

it.skipIf(!binary).each(["approval-required", "auto-accept-edits"] as const)(
  "owned native %s requires canonical once-approval without native custom-tool asks or persisted grants",
  async (mode) => {
    const app = await makeV2ThreadPluginFixture();
    const native = await sharedServiceNativeFixture(binary!, async (filename) => {
      const config = JSON.parse(await readFile(filename, "utf8"));
      config.plugins = [app.artifact.pluginUri];
      await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
    }).catch(async (error) => {
      await app.close();
      throw error;
    });
    const parent = ThreadId.makeUnsafe(`native-approved-${mode}`);
    try {
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      const eligibility = v2NativeCandidateFixtureVerifier(
        native,
        client,
        "Orchestration.approval.native",
      );
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
              runtimeMode: mode,
              consumeChildren: false,
            });
            const registration = yield* makeV2ApplicationRegistration(eligibility).pipe(
              Effect.provideService(ServerConfig, {
                stateDir: app.root,
                cwd: native.workspace,
                port: canonical.port,
                attachmentsDir: app.root,
              } as typeof ServerConfig.Service),
            );
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
            yield* adapter.startSession({
              threadId: parent,
              cwd: native.workspace,
              modelSelection: canonical.selection,
              runtimeMode: mode,
            });
            const session = (yield* adapter.listSessions()).find(
              (session) => session.threadId === parent,
            )!;
            const id = (session.resumeCursor as { nativeSessionId: string }).nativeSessionId;
            const before = yield* Effect.promise(() => client.session.get({ sessionID: id }));
            native.state.tool = `bb2_${app.artifact.issuer.slice(0, 32)}_create_thread`;
            native.state.input = {
              title: "Once approved child",
              task: "Synthetic independent canonical task",
            };
            yield* adapter.sendTurn({
              threadId: parent,
              input: "Create the synthetic canonical child",
              requestMessageId: MessageId.makeUnsafe("native-canonical-approval"),
            });
            yield* Effect.promise(() =>
              expect
                .poll(() => events.find((event) => event.type === "request.opened"), {
                  timeout: 10000,
                })
                .toBeDefined(),
            );
            const firstAsk = events.find((event) => event.type === "request.opened")!;
            expect(firstAsk.requestId).toMatch(/^bbv2-thread:/);
            expect(
              (yield* Effect.promise(() => canonical.run(canonical.engine.getReadModel()))).threads,
            ).toHaveLength(1);
            yield* Effect.promise(() =>
              expect
                .poll(
                  () =>
                    events.find(
                      (event) =>
                        event.type === "request.opened" &&
                        event.requestId?.startsWith("bbv2-thread:"),
                    ),
                  { timeout: 10000 },
                )
                .toBeDefined(),
            );
            const canonicalAsk = events.find(
              (event) =>
                event.type === "request.opened" && event.requestId?.startsWith("bbv2-thread:"),
            )!;
            expect(
              (yield* Effect.promise(() => canonical.run(canonical.engine.getReadModel()))).threads,
            ).toHaveLength(1);
            expect(
              yield* adapter
                .respondToRequest(
                  parent,
                  ApprovalRequestId.makeUnsafe(canonicalAsk.requestId!),
                  "acceptForSession",
                )
                .pipe(Effect.result),
            ).toMatchObject({ _tag: "Failure" });
            yield* adapter.respondToRequest(
              parent,
              ApprovalRequestId.makeUnsafe(canonicalAsk.requestId!),
              "accept",
            );
            yield* Effect.promise(() =>
              expect
                .poll(
                  async () => (await canonical.run(canonical.engine.getReadModel())).threads.length,
                  { timeout: 10000 },
                )
                .toBe(2),
            );
            yield* Effect.promise(() =>
              client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(10000) }),
            );
            expect(
              events
                .filter((event) => event.type === "request.opened")
                .every((event) => event.requestId?.startsWith("bbv2-thread:")),
            ).toBe(true);
            expect(
              (yield* Effect.promise(() => client.session.get({ sessionID: id }))).permissions,
            ).toEqual(before.permissions);
            expect(
              yield* Effect.promise(() =>
                client.permission.saved.list({ projectID: before.projectID }),
              ),
            ).toEqual([]);
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(persistence, NodeServices.layer)),
          Effect.provideService(ServerSettingsService, settings),
        ),
      );
    } finally {
      await native.close();
      await app.close();
    }
  },
  60000,
);
