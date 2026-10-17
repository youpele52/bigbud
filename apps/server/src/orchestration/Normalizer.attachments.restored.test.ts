import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ThreadId, type ClientOrchestrationCommand } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { resolveAttachmentPath } from "../attachments/attachmentStore.ts";

it("desktop image paths normalize into native image snapshots and browser bytes into persisted readable file paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "normalized-attachments-"));
  const source = path.join(root, "image.png");
  const bytes = await readFile(new URL("../../../web/public/favicon-16x16.png", import.meta.url));
  await writeFile(source, bytes);
  const layer = Layer.empty.pipe(
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "restored-attachments-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const command = {
            type: "thread.message.submit",
            commandId: CommandId.makeUnsafe("attachments"),
            threadId: ThreadId.makeUnsafe("attachments"),
            delivery: "auto",
            createdAt: "2026-10-09T00:00:00.000Z",
            modelSelection: { provider: "opencodeV2", model: "synthetic" },
            message: {
              messageId: MessageId.makeUnsafe("message"),
              text: "read",
              attachments: [
                {
                  type: "file",
                  transport: "path",
                  filePath: source,
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: bytes.length,
                },
                {
                  type: "file",
                  transport: "base64",
                  dataUrl: "data:text/plain;base64,Y29udGV4dA==",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 7,
                },
              ],
            },
          } satisfies ClientOrchestrationCommand;
          const normalized = yield* normalizeDispatchCommand(command);
          if (!("message" in normalized)) throw new Error("Wrong normalized command");
          const [image, file] = normalized.message.attachments!;
          expect(image?.type).toBe("image");
          expect(file?.type).toBe("file");
          if (!image || !file || file.type !== "file") throw new Error("Missing snapshots");
          expect(file.sourcePath).toBe(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: file }),
          );
          expect(yield* Effect.promise(() => readFile(file.sourcePath!, "utf8"))).toBe("context");
          yield* Effect.promise(() => writeFile(source, "mutated source"));
          expect(
            yield* Effect.promise(() =>
              readFile(
                resolveAttachmentPath({
                  attachmentsDir: config.attachmentsDir,
                  attachment: image,
                })!,
              ),
            ),
          ).toEqual(bytes);
        }).pipe(Effect.provide(layer)),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
