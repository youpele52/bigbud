import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS, MessageId, ThreadId } from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { makeOwnedClient } from "./Client.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;

/** Read only synthetic provider-system messages, never a production transcript. */
function system(request: Record<string, unknown>) {
  return (request.messages as { role: string; content: unknown }[]).filter(
    (message) => message.role === "system",
  );
}

/** Compare executable tool names independently of varying browser MCP guidance. */
function tools(request: Record<string, unknown>) {
  return (request.tools as { function: { name: string } }[])
    .map((tool) => tool.function.name)
    .toSorted();
}

/** Compare native request construction without touching live accounts or depending on vendor eligibility heuristics. */
it.skipIf(!binary || !version || process.platform !== "darwin")(
  "keeps native Build base instructions, skills and tools while app context is additive and subagent ownership remains denied",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!);
    try {
      const configBefore = await readFile(fixture.configFile);
      const serviceBefore = await readFile(fixture.file);
      const discovery = await discoverV2SharedService({ file: fixture.file });
      const client = makeOwnedClient({
        endpoint: discovery.registration.endpoint.url,
        password: discovery.registration.endpoint.auth!.password,
      });
      const model = { providerID: "bigbud-v2-fixture", id: "synthetic-model" };
      const text = "delegated_thread_provenance: disposable request-context comparison";
      const sibling = await client.session.create({
        location: { directory: fixture.workspace },
        agent: "build",
        model,
      });
      await client.session.prompt({ sessionID: sibling.id, text, files: [] });
      await expect
        .poll(async () => (await client.session.get({ sessionID: sibling.id })).outcome, {
          timeout: 15000,
        })
        .toBe("succeeded");
      const baseline = fixture.state.requests.find(
        (request) =>
          JSON.stringify(request.messages).includes(text) &&
          Array.isArray(request.tools) &&
          request.tools.length > 0,
      )!;
      expect(baseline).toBeDefined();
      const settings = {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencodeV2: {
              enabled: true,
              binaryPath: "",
              profileRoot: "",
              serviceFile: fixture.file,
            },
          },
        }),
        streamChanges: Stream.never,
      } as unknown as typeof ServerSettingsService.Service;
      const threadId = ThreadId.makeUnsafe("shared-native-context");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registration = yield* makeV2ApplicationRegistration();
            const adapter = registration.adapterService;
            const session = yield* adapter.startSession({
              threadId,
              cwd: fixture.workspace,
              runtimeMode: "full-access",
              modelSelection: {
                provider: "opencodeV2",
                subProviderID: model.providerID,
                model: model.id,
              },
            });
            const nativeId = (session.resumeCursor as { nativeSessionId: string }).nativeSessionId;
            const requestCount = fixture.state.requests.length;
            yield* adapter.sendTurn({
              threadId,
              input: text,
              requestMessageId: MessageId.makeUnsafe("native-context-comparison"),
            });
            yield* Effect.promise(() =>
              expect
                .poll(async () => (await client.session.get({ sessionID: nativeId })).outcome, {
                  timeout: 15000,
                })
                .toBe("succeeded"),
            );
            const actual = fixture.state.requests
              .slice(requestCount)
              .find(
                (request) =>
                  JSON.stringify(request.messages).includes(text) &&
                  Array.isArray(request.tools) &&
                  request.tools.length > 0,
              )!;
            expect(actual).toBeDefined();
            const base = system(baseline);
            const app = system(actual);
            expect(base.length).toBeGreaterThan(0);
            // Native transport folds initial context into the first system message. Code Mode
            // inventories legitimately grow when the app's configured browser MCP is connected.
            expect(String(app[0]!.content).split("# Code Mode")[0]).toEqual(
              String(base[0]!.content).split("# Code Mode")[0],
            );
            expect(JSON.stringify(app)).toContain("Disposable qualification skill");
            expect(JSON.stringify(base)).toContain("Disposable qualification skill");
            expect(JSON.stringify(app)).toContain("Selected bigbud access mode");
            expect(JSON.stringify(base)).not.toContain("Selected bigbud access mode");
            expect(tools(baseline)).toContain("subagent");
            expect(tools(actual)).not.toContain("subagent");
            expect(tools(actual)).toEqual(tools(baseline).filter((name) => name !== "subagent"));
            const native = yield* Effect.promise(() => client.session.get({ sessionID: nativeId }));
            expect(native.agent).toBeUndefined();
            expect(native.permissions).toContainEqual({
              action: "subagent",
              resource: "*",
              effect: "deny",
            });
            const history = yield* Effect.promise(() =>
              client.message.list({ sessionID: nativeId }),
            );
            const assistants = history.data.filter((message) => message.type === "assistant");
            expect(assistants.length).toBeGreaterThan(0);
            expect(assistants.every((message) => message.agent === "build")).toBe(true);
            yield* adapter.stopSession(threadId);
          }),
        ).pipe(
          Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ServerConfig, {
            cwd: fixture.workspace,
            stateDir: path.join(fixture.profile, "bigbud-state"),
            port: 0,
          } as typeof ServerConfig.Service),
        ),
      );
      expect((await client.server.info()).version).toBe(version);
      expect((await client.server.info()).pid).toBe(fixture.child.pid);
      expect(await readFile(fixture.configFile)).toEqual(configBefore);
      expect(await readFile(fixture.file)).toEqual(serviceBefore);
    } finally {
      await fixture.close();
    }
  },
  60000,
);
