import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { makeV2CodingNativeFixture } from "./Coding.native.fixture.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
it.skipIf(!binary || process.platform !== "darwin")(
  "pinned 2.0.26 delivers small managed text/native images and replays after process restart without source reads or resend",
  async () => {
    const fixture = await makeV2CodingNativeFixture();
    const configPath = path.join(fixture.profile, "config", "opencode", "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.providers["bigbud-v2-fixture"].models["synthetic-model"].capabilities = {
      tools: false,
      input: ["text", "image"],
      output: ["text"],
    };
    await writeFile(configPath, JSON.stringify(config));
    const attachmentsDir = path.join(fixture.profile, "attachments");
    await mkdir(attachmentsDir, { mode: 0o700 });
    const bytes = await readFile(
      new URL("../../../../../web/public/favicon-16x16.png", import.meta.url),
    );
    const image = {
      type: "image",
      id: "small-image",
      name: "pixel.png",
      mimeType: "image/png",
      sizeBytes: bytes.length,
    } as const;
    const document = {
      type: "file",
      id: "small-doc",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 16,
      sourcePath: "/never/reread",
    } as const;
    const imagePath = resolveAttachmentPath({ attachmentsDir, attachment: image })!;
    await writeFile(imagePath, bytes);
    await writeFile(
      resolveAttachmentPath({ attachmentsDir, attachment: document })!,
      "document context",
    );
    const layer = ProviderTurnAdmissionsLive.pipe(Layer.provide(SqlitePersistenceMemory));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            const runtime = new OpencodeV2Runtime({
              manager: new OpencodeV2ServerManager({
                maxProcesses: 1,
                maxOwners: 25,
                maxQueuedEvents: 128,
                maxEventBytes: 2000000,
                consumerTimeoutMs: 15000,
              }),
              journal,
              config: {
                binaryPath: binary!,
                profileRoot: fixture.profile,
                runtimeTargetId: "local",
              },
              attachmentsDir,
              allowLocalWorkspace: true,
              pollIntervalMs: 100,
              emit: async () => {},
            });
            try {
              const threadId = ThreadId.makeUnsafe("native-attachments");
              const modelSelection = {
                provider: "opencodeV2",
                subProviderID: "bigbud-v2-fixture",
                model: "synthetic-model",
              } as const;
              yield* Effect.promise(() =>
                runtime.start({
                  threadId,
                  modelSelection,
                  cwd: fixture.workspace,
                  runtimeMode: "approval-required",
                }),
              );
              const input = {
                threadId,
                modelSelection,
                requestMessageId: MessageId.makeUnsafe("native-media"),
                input: "Use attached context and original image",
                attachments: [document, image],
              };
              const accepted = yield* Effect.promise(() => runtime.send(input));
              yield* Effect.promise(() =>
                expect
                  .poll(() => runtime.get(threadId).terminalDelivered, { timeout: 20000 })
                  .toBe(true),
              );
              const request = JSON.stringify(fixture.state.requests);
              expect(request).toContain("document context");
              expect(request).toContain("image_url");
              expect(request).not.toContain(document.sourcePath);
              const requests = fixture.state.modelRequests;
              yield* Effect.promise(() => rm(imagePath));
              yield* Effect.promise(() => runtime.send(input));
              expect(fixture.state.modelRequests).toBe(requests);
              yield* Effect.promise(() =>
                rm(resolveAttachmentPath({ attachmentsDir, attachment: document })!),
              );
              yield* Effect.promise(() => runtime.close());
              const restarted = new OpencodeV2Runtime({
                ...runtime.options,
                manager: new OpencodeV2ServerManager({
                  maxProcesses: 1,
                  maxOwners: 25,
                  maxQueuedEvents: 128,
                  maxEventBytes: 2000000,
                  consumerTimeoutMs: 15000,
                }),
              });
              try {
                yield* Effect.promise(() =>
                  restarted.start({
                    threadId,
                    modelSelection,
                    cwd: fixture.workspace,
                    runtimeMode: "approval-required",
                    resumeCursor: accepted.resumeCursor,
                  }),
                );
                yield* Effect.promise(() => restarted.send(input));
                expect(fixture.state.modelRequests).toBe(requests);
              } finally {
                yield* Effect.promise(() => restarted.close());
              }
            } finally {
              yield* Effect.promise(() => runtime.close());
            }
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      await fixture.close();
    }
  },
  60000,
);
