import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { makeAdapterLookup } from "../ProviderAdapterRegistry.ts";
import { V2_DEVELOPMENT_MARKER } from "./Development.config.ts";
import { makeBackgroundReviews } from "../ProviderService.backgroundReview.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";
import { supportsScheduledLearning } from "../../providerWorkloadSupport.ts";
import { readV2ApplicationConfig } from "./Application.config.ts";
import { ServerConfig, type ServerConfigShape } from "../../../startup/config.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary).each([false, true])(
  "routes V2 through real composition, journal and canonical stream (application=%s)",
  async (application) => {
    let requests = 0;
    let transient = false;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      requests++;
      if (transient) {
        transient = false;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Disposable transient failure", type: "server_error" },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "composed canonical output" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint failed.");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-composition-")));
    const profileRoot = path.join(root, application ? "app-profile" : "dev-profile");
    if (application) await readV2ApplicationConfig({ binaryPath: binary!, profileRoot });
    else await mkdir(profileRoot, { mode: 0o700 });
    // Application Locations are real local workspaces outside its private runtime storage.
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const attachmentsDir = path.join(root, "uploads");
    await mkdir(attachmentsDir, { mode: 0o700 });
    await writeFile(
      path.join(attachmentsDir, "synthetic-upload.txt"),
      "Synthetic managed attachment",
      { mode: 0o600 },
    );
    const attachments = application
      ? [
          {
            type: "file" as const,
            id: "synthetic-upload",
            name: "upload.txt",
            mimeType: "text/plain",
            sizeBytes: 28,
          },
        ]
      : [];
    await mkdir(path.join(profileRoot, "config", "opencode"), { recursive: true });
    await writeFile(
      path.join(profileRoot, V2_DEVELOPMENT_MARKER),
      "bigbud-opencode-v2-disposable-v1\n",
      {
        mode: 0o600,
      },
    );
    await writeFile(
      path.join(profileRoot, "config", "opencode", "opencode.json"),
      JSON.stringify({
        providers: {
          "bigbud-composition-fixture": {
            name: "Fixture",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "disposable-only" },
            models: {
              "fixture-model": { name: "Fixture", limit: { context: 32000, output: 4000 } },
            },
          },
        },
      }),
    );
    const environment = {
      BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
      BIGBUD_OPENCODE_V2_BINARY: binary!,
      BIGBUD_OPENCODE_V2_PROFILE_ROOT: profileRoot,
      BIGBUD_OPENCODE_V2_WORKSPACE: workspace,
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: { enabled: true, binaryPath: binary!, profileRoot },
      },
    };
    const settingsService = {
      getSettings: Effect.succeed(settings),
      streamChanges: Stream.empty,
    } as unknown as typeof ServerSettingsService.Service;
    const persistence = ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registrations = yield* composeOptionalProviders(
              [],
              application ? {} : environment,
            );
            const registration = registrations.find((value) => value.provider === "opencodeV2")!;
            const registry = makeAdapterLookup([registration.adapterService]);
            const adapter = yield* registry.getByProvider("opencodeV2");
            expect(adapter).toBe(registration.adapterService);
            expect(
              supportsScheduledLearning("opencodeV2", adapter.capabilities.durableLearningReview),
            ).toBe(true);
            const [cold, concurrent] = yield* Effect.all(
              [registration.providerService.refresh, registration.providerService.refresh],
              { concurrency: "unbounded" },
            );
            expect(concurrent).toEqual(cold);
            expect(cold.developmentOnly).toBe(application ? undefined : true);
            expect(cold.enabled).toBe(true);
            expect(cold.turnControl).toEqual(adapter.capabilities.turnControl);
            expect(
              cold.models.some(
                (model) =>
                  model.slug === "fixture-model" &&
                  model.subProviderID === "bigbud-composition-fixture",
              ),
            ).toBe(true);
            expect(requests).toBe(0);
            const journal = yield* ProviderTurnAdmissions;
            const events: ProviderRuntimeEvent[] = [];
            const background = makeBackgroundReviews({
              registry,
              serverSettings: settingsService,
              getProviderCapabilities: () => registration.capabilities,
              isProviderComposed: (provider) => provider === "opencodeV2",
            });
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                background.isBackground(event.threadId)
                  ? background.process(event)
                  : Effect.sync(() => {
                      events.push(event);
                    }),
              ),
              Effect.forkScoped,
            );
            yield* Effect.sleep("10 millis");
            const threadId = ThreadId.makeUnsafe("composed-v2");
            const modelSelection = {
              provider: "opencodeV2",
              subProviderID: "bigbud-composition-fixture",
              model: "fixture-model",
            } as const;
            const started = yield* adapter.startSession({
              threadId,
              cwd: workspace,
              runtimeMode: "approval-required",
              modelSelection,
            });
            yield* adapter.sendTurn({
              threadId,
              requestMessageId: MessageId.makeUnsafe("composed-request"),
              input: "Synthetic output, no tools",
              attachments,
              modelSelection,
            });
            yield* Effect.promise(async () => {
              await expect
                .poll(
                  () =>
                    events.some(
                      (event) =>
                        event.type === "turn.completed" && event.payload.state === "completed",
                    ),
                  { timeout: 15000 },
                )
                .toBe(true);
              expect(
                events.find(
                  (event) =>
                    event.type === "item.completed" &&
                    event.payload.itemType === "assistant_message",
                )?.payload,
              ).toMatchObject({ detail: "composed canonical output" });
              expect(requests).toBeGreaterThan(0);
            });
            const row = yield* journal.find({
              namespace: "foreground",
              ownerThreadId: threadId,
              requestMessageId: MessageId.makeUnsafe("composed-request"),
            });
            expect(row?.finalText).toBe("composed canonical output");
            const snapshot = yield* registration.providerService.refresh;
            expect(snapshot.developmentOnly).toBe(application ? undefined : true);
            expect(snapshot.enabled).toBe(true);
            expect(snapshot.version).toBe("2.0.19");
            expect(snapshot.auth.status).toBe("unknown");
            expect(
              snapshot.models.some(
                (model) =>
                  model.slug === "fixture-model" &&
                  model.subProviderID === "bigbud-composition-fixture",
              ),
            ).toBe(true);
            yield* adapter.stopSession(threadId);
            expect(started.resumeCursor).toMatchObject({ provider: "opencodeV2" });
            yield* adapter.startSession({
              threadId,
              cwd: workspace,
              runtimeMode: "approval-required",
              modelSelection,
              resumeCursor: started.resumeCursor,
            });
            const before = requests;
            yield* adapter.sendTurn({
              threadId,
              requestMessageId: MessageId.makeUnsafe("composed-request"),
              input: "Synthetic output, no tools",
              attachments,
              modelSelection,
            });
            expect(requests).toBe(before);
            transient = true;
            const retried = yield* adapter.sendTurn({
              threadId,
              requestMessageId: MessageId.makeUnsafe("composed-transient"),
              input: "Synthetic transient retry",
              modelSelection,
            });
            yield* Effect.promise(async () => {
              await expect
                .poll(
                  () =>
                    events.some(
                      (event) =>
                        event.type === "turn.completed" &&
                        event.turnId === retried.turnId &&
                        event.payload.state === "completed",
                    ),
                  { timeout: 15000 },
                )
                .toBe(true);
              expect(requests).toBe(before + 2);
              expect(
                events.filter(
                  (event) => event.type === "turn.completed" && event.turnId === retried.turnId,
                ),
              ).toHaveLength(1);
            });
            const retryRow = yield* journal.find({
              namespace: "foreground",
              ownerThreadId: threadId,
              requestMessageId: MessageId.makeUnsafe("composed-transient"),
            });
            expect(retryRow?.terminalOutcome).toBe("completed");
            expect(retryRow?.finalText).toBe("composed canonical output");
            yield* adapter.stopSession(threadId);
            const rejectedRebind = yield* adapter
              .startSession({
                threadId,
                cwd: workspace,
                runtimeMode: "approval-required",
                resumeCursor: started.resumeCursor,
                modelSelection: {
                  ...modelSelection,
                  options: { variant: "not-the-existing-variant" },
                },
              })
              .pipe(Effect.result);
            expect(rejectedRebind._tag).toBe("Failure");
            expect(requests).toBe(before + 2);
            const job = {
              ownerThreadId: threadId,
              jobId: "composed-learning",
              cwd: workspace,
              modelSelection,
              input: "Synthetic isolated job",
            };
            expect(yield* background.run(job)).toBe("composed canonical output");
            const learning = learningAdmissionIdentity(threadId, job.jobId);
            const learned = yield* journal.find(learning.identity);
            expect(learned?.namespace).toBe("learning");
            expect(learned?.terminalOutcome).toBe("completed");
            expect(events.some((event) => event.threadId === learning.threadId)).toBe(false);
            expect(
              (yield* background.forDiscovery(adapter).listSessions()).some(
                (session) => session.threadId === learning.threadId,
              ),
            ).toBe(false);
            yield* adapter.stopAll();
            yield* Effect.promise(async () => {
              expect(
                (await readFile(path.join(profileRoot, "data", "opencode", "opencode.db"))).length,
              ).toBeGreaterThan(0);
            });
          }).pipe(
            Effect.provide(persistence),
            Effect.provideService(ServerSettingsService, settingsService),
            Effect.provideService(ServerConfig, { attachmentsDir } as ServerConfigShape),
          ),
        ),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
