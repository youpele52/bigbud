import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { makeOwnedClient } from "./Client.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { v2NativeCandidateFixtureVerifier } from "./NativeCompatibility.candidate.fixture.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
type Defect = "missing" | "issuer" | "hash" | "version" | "inventory";

it.skipIf(!binary)(
  "production startup and every new turn fail closed on missing/mismatched required plugin without hiding models or mutating compatible history",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const native = await sharedServiceNativeFixture(binary!, async (filename) => {
      const config = JSON.parse(await readFile(filename, "utf8"));
      config.plugins = [app.artifact.pluginUri];
      await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
    }).catch(async (error) => {
      await app.close();
      throw error;
    });
    let defect: Defect | undefined;
    const mutations: Array<{ method: string; path: string }> = [];
    const fetch = globalThis.fetch;
    // Faults enter at the actual guarded native wire, not at the readiness/runtime functions.
    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      const method = init?.method ?? (request instanceof Request ? request.method : "GET");
      if (url.pathname.startsWith("/api/session") && !["GET", "HEAD"].includes(method))
        mutations.push({ method, path: url.pathname });
      if (defect && url.pathname === "/api/rpc/bigbud.thread.v1/info") {
        if (defect === "missing")
          return new Response("Required plugin not loaded", { status: 404 });
        const response = await fetch(request, init);
        const result = (await response.json()) as { output: Record<string, unknown> };
        if (defect === "issuer") result.output.issuer = "f".repeat(64);
        if (defect === "hash") result.output.artifactDigest = "e".repeat(64);
        if (defect === "version")
          result.output.nativeVersion =
            native.approval.nativeVersion === "2.0.28" ? "2.0.26" : "2.0.28";
        if (defect === "inventory") result.output.tools = ["bigbud_thread_v1_create_thread"];
        return Response.json(result);
      }
      return fetch(request, init);
    });
    try {
      const configBefore = await readFile(native.configFile);
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      const eligibility = v2NativeCandidateFixtureVerifier(
        native,
        client,
        "Orchestration.readiness.failure.native",
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
            const journal = yield* ProviderTurnAdmissions;
            const bindings = yield* OpencodeV2SharedBindings;
            const registration = yield* makeV2ApplicationRegistration(eligibility).pipe(
              Effect.provideService(ServerConfig, {
                stateDir: app.root,
                cwd: native.workspace,
                port: 0,
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
            const threadId = ThreadId.makeUnsafe("retained-compatible-readiness");
            const selection = {
              provider: "opencodeV2" as const,
              subProviderID: "bigbud-v2-fixture",
              model: "synthetic-model",
            };
            const session = yield* adapter.startSession({
              threadId,
              cwd: native.workspace,
              runtimeMode: "full-access",
              modelSelection: selection,
            });
            const nativeId = (session.resumeCursor as { nativeSessionId: string }).nativeSessionId;
            yield* adapter.sendTurn({
              threadId,
              input: "delegated_thread_provenance: establish disposable compatible history",
              requestMessageId: MessageId.makeUnsafe("readiness-original"),
            });
            yield* Effect.promise(() =>
              expect
                .poll(() => events.some((event) => event.type === "turn.completed"), {
                  timeout: 15000,
                })
                .toBe(true),
            );
            const originalBinding = yield* bindings.find(threadId);
            const originalAdmission = yield* journal.latestBound(threadId);
            const originalNative = yield* Effect.promise(() =>
              client.session.get({ sessionID: nativeId }),
            );
            const originalHistory = yield* Effect.promise(() =>
              client.message.list({ sessionID: nativeId }),
            );
            const originalModels = (yield* registration.providerService.refresh).models;
            expect(originalModels.some((model) => model.slug === selection.model)).toBe(true);
            const originalRequests = native.state.requests.length;
            for (const phase of ["startup", "new-turn"] as const) {
              for (const failure of [
                "missing",
                "issuer",
                "hash",
                "version",
                "inventory",
              ] as const) {
                defect = failure;
                mutations.length = 0;
                const failedThread = ThreadId.makeUnsafe(`failed-${phase}-${failure}`);
                const requestMessageId = MessageId.makeUnsafe(`blocked-${failure}`);
                const result = yield* (
                  phase === "startup"
                    ? adapter
                        .startSession({
                          threadId: failedThread,
                          cwd: native.workspace,
                          runtimeMode: "full-access",
                          modelSelection: selection,
                        })
                        .pipe(Effect.asVoid)
                    : adapter
                        .sendTurn({ threadId, input: "Never admitted", requestMessageId })
                        .pipe(Effect.asVoid)
                ).pipe(Effect.result);
                expect(result).toMatchObject({
                  _tag: "Failure",
                  failure: {
                    message: expect.stringContaining("required bigbud thread-tools setup"),
                  },
                });
                expect(
                  mutations,
                  `${phase}/${failure}: native create/update/prompt/delete`,
                ).toEqual([]);
                expect(native.state.requests).toHaveLength(originalRequests);
                expect((yield* registration.providerService.refresh).models).toEqual(
                  originalModels,
                );
                expect(yield* bindings.find(threadId)).toEqual(originalBinding);
                expect(yield* journal.latestBound(threadId)).toEqual(originalAdmission);
                expect(yield* journal.latestBound(failedThread)).toBeUndefined();
                expect(
                  yield* journal.find({
                    namespace: "foreground",
                    ownerThreadId: threadId,
                    requestMessageId,
                  }),
                ).toBeUndefined();
                expect(
                  yield* Effect.promise(() => client.session.get({ sessionID: nativeId })),
                ).toEqual(originalNative);
                expect(
                  yield* Effect.promise(() => client.message.list({ sessionID: nativeId })),
                ).toEqual(originalHistory);
                expect(yield* adapter.hasSession(failedThread)).toBe(false);
              }
            }
            defect = undefined;
            expect((yield* adapter.listSessions()).map((owner) => owner.threadId)).toEqual([
              threadId,
            ]);
            yield* adapter.stopSession(threadId);
          }),
        ).pipe(
          Effect.provide(Layer.mergeAll(persistence, NodeServices.layer)),
          Effect.provideService(ServerSettingsService, settings),
        ),
      );
      expect(await readFile(native.configFile)).toEqual(configBefore);
    } finally {
      defect = undefined;
      wire.mockRestore();
      await native.close();
      await app.close();
    }
  },
  60000,
);
