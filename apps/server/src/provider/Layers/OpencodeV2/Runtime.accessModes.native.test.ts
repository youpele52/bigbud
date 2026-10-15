import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
  ThreadId,
  MessageId,
  ApprovalRequestId,
  DEFAULT_SERVER_SETTINGS,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { v2SharedNativePersistence } from "./SharedService.native.runtime.fixture.ts";

vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));

// Production shared application path: the approval-gated retail fixture's registered service with
// the required thread-tools plugin installed, borrowed through managed native trust (never launched).
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
  it.skipIf(!binary)(
    `normal pinned application ${mode} executes its actual policy, including native pipelines only with the appropriate trust`,
    async () => {
      const appFixture = await makeV2ThreadPluginFixture();
      const fixture = await sharedServiceNativeFixture(binary!, async (file) => {
        const config = JSON.parse(await readFile(file, "utf8"));
        config.plugins = [appFixture.artifact.pluginUri];
        config.providers["bigbud-v2-fixture"].models["synthetic-model"].limit.context =
          mode === "full-access" ? 4000000 : 32000;
        await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      }).catch(async (error) => {
        await appFixture.close();
        throw error;
      });
      // Shared mode has no bigbud coding-bridge tools; the bounded edit uses native `write`.
      fixture.state.tool = mode === "auto-accept-edits" ? "write" : "shell";
      fixture.state.input =
        mode === "auto-accept-edits"
          ? { path: path.join(fixture.workspace, "result.txt"), content: "AUTOMATIC BOUNDED EDIT" }
          : {
              command: "printf 'trusted native pipeline' | tr a-z A-Z > result.txt",
              description: "Exact approved pipeline",
              timeout: 5000,
            };
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
              serviceFile: fixture.file,
              nativeServiceTrust: "managed-thread-tools-v2",
              nativePluginConfigRoot: path.dirname(fixture.configFile),
            },
          },
        }),
      );
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
              Effect.provide(v2SharedNativePersistence),
              Effect.provideService(ServerSettingsService, settings),
              Effect.provideService(ServerConfig, {
                cwd: fixture.workspace,
                stateDir: appFixture.root,
                attachmentsDir: path.join(appFixture.root, "attachments"),
                port: 0,
              } as typeof ServerConfig.Service),
            ),
          ),
        );
      } finally {
        await fixture.close();
        await appFixture.close();
      }
    },
    45000,
  );
}
