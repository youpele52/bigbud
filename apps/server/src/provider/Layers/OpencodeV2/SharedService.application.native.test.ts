import { readFile, access, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { resolveV2SharedStorage } from "./SharedService.storage.ts";
import { makeOwnedClient } from "./Client.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({
    models: [
      {
        slug: "synthetic-model",
        subProviderID: "azure",
        name: "Synthetic public-only",
        group: "Azure",
        isCustom: false,
        capabilities: null,
        availability: "requires-setup",
      },
    ],
    stale: false,
  }),
}));
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;

it.skipIf(!binary || !version || process.platform !== "darwin")(
  "shared application qualifies replay, native tools, disable/rebind and active TUI sibling preservation",
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
      const stateDir = path.join(path.dirname(fixture.workspace), "bigbud-state");
      const attachmentsDir = path.join(stateDir, "uploads");
      await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
      const attachment = {
        type: "file",
        id: "shared-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
      } as const;
      const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment })!;
      await writeFile(attachmentPath, "context");
      await readV2NativeCatalog(client, fixture.workspace);
      const sibling = await client.session.create({
        id: "ses_tui_app_qualification",
        model,
        location: { directory: fixture.workspace },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "ask" },
        ],
      });
      fixture.state.tool = "shell";
      fixture.state.input = { command: "echo never approved", description: "TUI-like sibling" };
      await client.session.prompt({
        sessionID: sibling.id,
        id: "msg_tui_app_qualification",
        text: "Synthetic sibling waits for approval",
        files: [],
      });
      await expect
        .poll(async () => (await client.permission.list({ sessionID: sibling.id })).length, {
          timeout: 15000,
        })
        .toBe(1);
      const historyBefore = await client.message.list({ sessionID: sibling.id });
      const permissionBefore = await client.permission.list({ sessionID: sibling.id });
      let current = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: { enabled: true, binaryPath: "", profileRoot: "", serviceFile: fixture.file },
        },
      };
      const settings = {
        getSettings: Effect.sync(() => current),
        streamChanges: Stream.never,
      } as unknown as typeof ServerSettingsService.Service;
      const selection = {
        provider: "opencodeV2",
        subProviderID: model.providerID,
        model: model.id,
      } as const;
      const threadId = ThreadId.makeUnsafe("shared-app-qualified");
      const turn = {
        threadId,
        modelSelection: selection,
        requestMessageId: MessageId.makeUnsafe("shared-app-qualified-request"),
        input: "delegated_thread_provenance: synthetic application qualification",
        attachments: [attachment],
      };
      let cursor: unknown;
      let promptCalls = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const registration = yield* makeV2ApplicationRegistration();
              const events: ProviderRuntimeEvent[] = [];
              yield* registration.adapterService.streamEvents.pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Effect.forkScoped,
              );
              const snapshot = yield* registration.providerService.refresh;
              expect(snapshot).toMatchObject({
                installed: true,
                status: "ready",
                version,
                auth: { status: "unknown" },
              });
              expect(snapshot.runtimeUpdateRecommended).toBe(
                version === "2.0.24" ? "2.0.26" : undefined,
              );
              expect(snapshot.models[0]?.subProviderID).toBe(model.providerID);
              expect(
                snapshot.models.some(
                  (item) =>
                    item.subProviderID === "azure" && item.availability === "requires-setup",
                ),
              ).toBe(true);
              expect(
                snapshot.nativeAgents?.some((agent) => agent.id === "qualification-reviewer"),
              ).toBe(true);
              expect(snapshot.skills.some((skill) => skill.name === "example")).toBe(true);
              const started = yield* registration.adapterService.startSession({
                threadId,
                cwd: fixture.workspace,
                modelSelection: selection,
                runtimeMode: "approval-required",
              });
              cursor = started.resumeCursor;
              yield* registration.adapterService.sendTurn(turn);
              yield* Effect.promise(() =>
                expect
                  .poll(() => events.some((event) => event.type === "turn.completed"), {
                    timeout: 15000,
                  })
                  .toBe(true),
              );
              promptCalls = fixture.state.modelRequests;
              yield* Effect.promise(() => rm(attachmentPath));
              yield* registration.adapterService.sendTurn(turn);
              expect(fixture.state.modelRequests).toBe(promptCalls);
              const sessionId = (cursor as { nativeSessionId: string }).nativeSessionId;
              const deny = yield* Effect.promise(() =>
                client.permission.create({
                  sessionID: sessionId,
                  action: "edit",
                  resources: [path.join(fixture.profile, "data", "opencode", "opencode.db")],
                }),
              );
              expect(deny.effect).toBe("deny");
              const approval = yield* Effect.promise(() =>
                client.permission.create({
                  sessionID: sessionId,
                  action: "shell",
                  resources: ["echo owned"],
                }),
              );
              expect(approval.effect).toBe("ask");
              yield* Effect.promise(() =>
                client.permission.reply({
                  sessionID: sessionId,
                  requestID: approval.id,
                  decision: "reject",
                }),
              );
              current = {
                ...current,
                providers: {
                  ...current.providers,
                  opencodeV2: { ...current.providers.opencodeV2, enabled: false },
                },
              };
              expect((yield* registration.providerService.refresh).enabled).toBe(false);
              expect(
                (yield* registration.adapterService.listSessions()).filter(
                  (item) => item.status !== "closed",
                ),
              ).toEqual([]);
            }),
          );
          current = {
            ...current,
            providers: {
              ...current.providers,
              opencodeV2: { ...current.providers.opencodeV2, enabled: true },
            },
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const registration = yield* makeV2ApplicationRegistration();
              const resumed = yield* registration.adapterService.startSession({
                threadId,
                cwd: fixture.workspace,
                modelSelection: selection,
                runtimeMode: "approval-required",
                resumeCursor: cursor,
              });
              expect(resumed.resumeCursor).toEqual(cursor);
              yield* registration.adapterService.sendTurn(turn);
              expect(fixture.state.modelRequests).toBe(promptCalls);
              yield* registration.adapterService.stopSession(threadId);
            }),
          );
        }).pipe(
          Effect.provide(ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory))),
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ServerConfig, {
            cwd: fixture.workspace,
            stateDir,
            attachmentsDir,
            port: 0,
          } as typeof ServerConfig.Service),
        ),
      );
      expect((await client.server.info()).pid).toBe(fixture.child.pid);
      expect((await client.session.active())[sibling.id]).toBeDefined();
      expect(await client.message.list({ sessionID: sibling.id })).toEqual(historyBefore);
      expect(await client.permission.list({ sessionID: sibling.id })).toEqual(permissionBefore);
      expect(await readFile(fixture.configFile)).toEqual(configBefore);
      expect(await readFile(fixture.file)).toEqual(serviceBefore);
      expect((await resolveV2SharedStorage(fixture.file)).storageIdentity).toBe(
        (cursor as { storageIdentity: string }).storageIdentity,
      );
      await expect(access(path.join(fixture.profile, ".bigbud-opencode-v2"))).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  },
  60000,
);
