import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import {
  makeV2SharedNativeRuntimeHarness,
  v2SharedNativePersistence,
} from "./SharedService.native.runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";

// Shared path: the approval-gated retail fixture's registered service, borrowed (never launched).
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
it.skipIf(!binary || process.platform !== "darwin")(
  "pinned native delivers small managed text/native images and replays after process restart without source reads or resend",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!, async (configPath) => {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.providers["bigbud-v2-fixture"].models["synthetic-model"].capabilities = {
        tools: false,
        input: ["text", "image"],
        output: ["text"],
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    });
    const harness = await makeV2SharedNativeRuntimeHarness(fixture);
    // App-owned state beside (never inside) the native profile, as production composes it.
    const stateDir = path.join(path.dirname(fixture.profile), "bigbud-state");
    const attachmentsDir = path.join(stateDir, "attachments");
    await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
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
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const journal = yield* ProviderTurnAdmissions;
            const runtime = new OpencodeV2Runtime({
              ...(yield* Effect.promise(() => harness.runtimeOptions())),
              journal,
              sharedBindings: yield* OpencodeV2SharedBindings,
              attachmentsDir,
              attachmentAdmissionsDir: path.join(stateDir, "opencode-v2-attachment-admissions"),
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
              // Physical restart of the fixture-owned native child (same database); the new
              // generation is rebound through a fresh borrowed manager, as after a bigbud restart.
              const firstPid = fixture.child.pid;
              yield* Effect.promise(() => fixture.restart());
              expect(fixture.child.pid).not.toBe(firstPid);
              const restarted = new OpencodeV2Runtime({
                ...runtime.options,
                ...(yield* Effect.promise(() => harness.runtimeOptions())),
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
          }).pipe(Effect.provide(v2SharedNativePersistence)),
        ),
      );
    } finally {
      harness.close();
      await fixture.close();
    }
  },
  60000,
);
