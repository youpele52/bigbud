import { readFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ThreadId, type UploadChatAttachment } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachments/attachmentStore.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { calculateCommandPayloadDigest } from "./commandDigest.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "submission-identity-" })),
  Layer.provideMerge(NodeServices.layer),
);
const image = {
  type: "image",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl: "data:image/png;base64,AA==",
} as const;
const file = {
  type: "file",
  transport: "base64",
  name: "note.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
  dataUrl: "data:text/plain;base64,AA==",
} as const;
const directory = {
  type: "path",
  name: "folder",
  mimeType: "inode/directory",
  sizeBytes: 0,
  path: "relative/folder",
  entryKind: "directory",
} as const;
const thread = {
  type: "thread",
  name: "Reference",
  mimeType: "application/x-bigbud-thread-reference",
  sizeBytes: 0,
  threadId: "reference-thread",
  title: "Reference",
  watchForCompletion: true,
} as const;
function submission(attachments: ReadonlyArray<UploadChatAttachment>) {
  return {
    type: "thread.message.submit" as const,
    commandId: CommandId.makeUnsafe("submit-identity"),
    threadId: ThreadId.makeUnsafe("thread-identity"),
    message: { messageId: MessageId.makeUnsafe("message-identity"), text: "hello", attachments },
    delivery: "auto" as const,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

function normalize(command: ReturnType<typeof submission>) {
  return normalizeDispatchCommand(command).pipe(
    Effect.map((result) => {
      if (result.type !== "thread.message.submit") throw new Error("Expected submission");
      return result;
    }),
  );
}

describe("submission attachment identity", () => {
  for (const attachment of [image, file, directory, thread]) {
    it(`preserves ${attachment.type} identity and ownership on identical retries`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const command = submission([attachment]);
          const first = yield* normalize(command);
          const second = yield* normalize(command);
          expect(second).toEqual(first);
          expect(calculateCommandPayloadDigest(second)).toEqual(
            calculateCommandPayloadDigest(first),
          );
          expect(parseThreadSegmentFromAttachmentId(first.message.attachments![0]!.id)).toBe(
            "thread-identity",
          );
        }).pipe(Effect.provide(TestLayer)),
      ));
  }

  it("preserves thread watch intent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* normalize(submission([thread]));
        expect(result.message.attachments![0]).toMatchObject({ watchForCompletion: true });
      }).pipe(Effect.provide(TestLayer)),
    ));

  it("includes actual bytes without overwriting an earlier attachment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const first = yield* normalize(submission([image]));
        const changed = yield* normalize(
          submission([{ ...image, dataUrl: "data:image/png;base64,AQ==" }]),
        );
        expect(changed.message.attachments![0]!.id).not.toBe(first.message.attachments![0]!.id);
        expect(calculateCommandPayloadDigest(changed)).not.toEqual(
          calculateCommandPayloadDigest(first),
        );
        const stored = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: first.message.attachments![0]!,
        })!;
        expect(yield* Effect.promise(() => readFile(stored))).toEqual(Buffer.from([0]));
      }).pipe(Effect.provide(TestLayer)),
    ));

  it("reuses immutable stored uploads and rejects corruption without overwriting", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const first = yield* normalize(submission([image]));
        const stored = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: first.message.attachments![0]!,
        })!;
        const before = yield* fs.stat(stored);
        yield* normalize(submission([image]));
        expect((yield* fs.stat(stored)).mtime).toEqual(before.mtime);
        yield* fs.writeFile(stored, Buffer.from([9]));
        const outcome = yield* normalize(submission([image])).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
        expect(yield* fs.readFile(stored)).toEqual(Buffer.from([9]));
      }).pipe(Effect.provide(TestLayer)),
    ));

  it("distinguishes message, command, position and metadata identities", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const command = submission([image, image]);
        const first = yield* normalize(command);
        expect(first.message.attachments![0]!.id).not.toBe(first.message.attachments![1]!.id);
        const variants = [
          { ...command, commandId: CommandId.makeUnsafe("another-command") },
          {
            ...command,
            message: { ...command.message, messageId: MessageId.makeUnsafe("another-message") },
          },
          submission([{ ...image, name: "other.png" }]),
        ];
        for (const variant of variants) {
          const result = yield* normalize(variant);
          expect(result.message.attachments![0]!.id).not.toBe(first.message.attachments![0]!.id);
        }
      }).pipe(Effect.provide(TestLayer)),
    ));

  it("hashes file contents for path transports and hydrated path references", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const source = path.join(config.stateDir, "source.txt");
        yield* fs.writeFile(source, Buffer.from("old"));
        const uploads: UploadChatAttachment[] = [
          {
            type: "file",
            transport: "path",
            filePath: source,
            name: "source.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
          },
          {
            type: "path",
            path: source,
            entryKind: "file",
            name: "source.txt",
            mimeType: "text/plain",
            sizeBytes: 0,
          },
        ];
        const first = yield* normalize(submission(uploads));
        const repeat = yield* normalize(submission(uploads));
        expect(repeat).toEqual(first);
        yield* fs.writeFile(source, Buffer.from("new"));
        const changed = yield* normalize(submission(uploads));
        for (let index = 0; index < uploads.length; index++) {
          expect(changed.message.attachments![index]!.id).not.toBe(
            first.message.attachments![index]!.id,
          );
          const stored = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: first.message.attachments![index]!,
          })!;
          expect(yield* fs.readFileString(stored)).toBe("old");
        }
      }).pipe(Effect.provide(TestLayer)),
    ));
});
