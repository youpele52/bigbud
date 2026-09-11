import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../startup/config.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "../Normalizer.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("submission-receipt-project");
const threadId = ThreadId.makeUnsafe("submission-receipt-thread");
const command = {
  type: "thread.message.submit" as const,
  commandId: CommandId.makeUnsafe("submission-receipt-command"),
  threadId,
  message: { messageId: MessageId.makeUnsafe("submission-receipt-message"), text: "hello" },
  delivery: "auto" as const,
  createdAt: "2026-09-11T00:00:00.000Z",
};

const NormalizerLayer = WorkspacePathsLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "submission-receipt-assets-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("normalized submission receipts", () => {
  it("replays omitted-field legacy receipts after normalization and restart", () =>
    withDatabase("submission-legacy-receipt-", async (dbPath) => {
      const normalizer = ManagedRuntime.make(NormalizerLayer);
      const first = createRuntime(dbPath);
      try {
        const engine = await engineFor(first);
        for (const create of createCommands(projectId, [threadId]))
          await first.runPromise(engine.dispatch(create));
        const accepted = await first.runPromise(engine.dispatch(command));
        await first.dispose();
        const second = createRuntime(dbPath);
        try {
          const restarted = await engineFor(second);
          const normalized = await normalizer.runPromise(normalizeDispatchCommand(command));
          await expect(second.runPromise(restarted.dispatch(normalized))).resolves.toEqual(
            accepted,
          );
        } finally {
          await second.dispose();
        }
      } finally {
        await first.dispose();
        await normalizer.dispose();
      }
    }));

  it("reconciles lost upload acknowledgments without duplicating execution or accepting changed content", () =>
    withDatabase("submission-upload-receipt-", async (dbPath) => {
      const normalizer = ManagedRuntime.make(NormalizerLayer);
      const first = createRuntime(dbPath);
      try {
        const source = await normalizer.runPromise(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const source = path.join(config.stateDir, "source.txt");
            yield* fs.writeFile(source, Buffer.from("contents"));
            return source;
          }),
        );
        const upload = {
          ...command,
          message: {
            ...command.message,
            attachments: [
              {
                type: "image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 1,
                dataUrl: "data:image/png;base64,AA==",
              },
              {
                type: "file",
                transport: "base64",
                name: "file.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
                dataUrl: "data:text/plain;base64,AA==",
              },
              {
                type: "file",
                transport: "path",
                name: "source.txt",
                mimeType: "text/plain",
                sizeBytes: 8,
                filePath: source,
              },
              {
                type: "path",
                path: source,
                name: "source",
                mimeType: "text/plain",
                sizeBytes: 0,
                entryKind: "file",
              },
              {
                type: "path",
                path: "relative/folder",
                name: "folder",
                mimeType: "inode/directory",
                sizeBytes: 0,
                entryKind: "directory",
              },
              {
                type: "thread",
                threadId: "reference",
                title: "Reference",
                name: "Reference",
                mimeType: "application/x-bigbud-thread-reference",
                sizeBytes: 0,
                watchForCompletion: true,
              },
            ],
          },
        } satisfies ClientOrchestrationCommand;
        const engine = await engineFor(first);
        for (const create of createCommands(projectId, [threadId]))
          await first.runPromise(engine.dispatch(create));
        const normalized = await normalizer.runPromise(normalizeDispatchCommand(upload));
        const accepted = await first.runPromise(engine.dispatch(normalized));
        await first.dispose();
        const second = createRuntime(dbPath);
        try {
          const restarted = await engineFor(second);
          const retry = await normalizer.runPromise(normalizeDispatchCommand(upload));
          await expect(second.runPromise(restarted.dispatch(retry))).resolves.toEqual(accepted);
          const changed = await normalizer.runPromise(
            normalizeDispatchCommand({
              ...upload,
              message: {
                ...upload.message,
                attachments: [
                  {
                    type: "image",
                    name: "image.png",
                    mimeType: "image/png",
                    sizeBytes: 1,
                    dataUrl: "data:image/png;base64,AQ==",
                  },
                  ...upload.message.attachments.slice(1),
                ],
              },
            }),
          );
          await expect(second.runPromise(restarted.dispatch(changed))).rejects.toMatchObject({
            _tag: "OrchestrationCommandIdConflictError",
          });
          const replay = await second.runPromise(restarted.readReplay(0));
          expect(
            replay.events.filter((event) => event.type === "thread.turn-start-requested"),
          ).toHaveLength(1);
          expect(
            replay.events.filter((event) => event.type === "thread.message-sent"),
          ).toHaveLength(1);
          await expect(
            second.runPromise(restarted.getCommandOutcome!(command.commandId)),
          ).resolves.toMatchObject({ status: "accepted", resultSequence: accepted.sequence });
        } finally {
          await second.dispose();
        }
      } finally {
        await first.dispose();
        await normalizer.dispose();
      }
    }));
});
