import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer } from "effect";

import { persistSubmissionAttachment } from "./Normalizer.attachmentStorage.ts";

const withTempDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "attachment-storage-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

const listEntries = (directory: string) => Effect.promise(() => readdir(directory));

/** The Node file system with some methods replaced, to fail or race one step of the upload. */
const patchedFileSystem = (patch: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(Effect.service(FileSystem.FileSystem), (fs) => ({ ...fs, ...patch(fs) })),
  ).pipe(Layer.provide(NodeServices.layer));

it.layer(NodeServices.layer)("persistSubmissionAttachment", (it) => {
  it.effect("publishes the upload and leaves no staging directory behind", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destination = join(directory, "attachment.png");
        const published = yield* persistSubmissionAttachment(destination, Buffer.from("image"));

        assert.strictEqual(published, true);
        assert.strictEqual(yield* Effect.promise(() => readFile(destination, "utf8")), "image");
        assert.deepStrictEqual(yield* listEntries(directory), ["attachment.png"]);
      }),
    ),
  );

  it.effect("leaves no staging directory behind when the destination already matches", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destination = join(directory, "attachment.png");
        yield* Effect.promise(() => writeFile(destination, "image"));
        const published = yield* persistSubmissionAttachment(destination, Buffer.from("image"));

        assert.strictEqual(published, false);
        assert.deepStrictEqual(yield* listEntries(directory), ["attachment.png"]);
      }),
    ),
  );

  it.effect("removes the staging directory when writing the upload fails", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destination = join(directory, "attachment.png");
        const exit = yield* persistSubmissionAttachment(destination, Buffer.from("image")).pipe(
          Effect.exit,
          Effect.provide(
            patchedFileSystem((fs) => ({
              // A genuine write failure (ENOENT), as a full or vanished disk would give.
              writeFile: (path, data, options) =>
                fs.writeFile(join(path, "missing", "upload"), data, options),
            })),
          ),
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(yield* listEntries(directory), []);
      }),
    ),
  );

  it.effect("verifies a destination that appears while publishing, then cleans up", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destination = join(directory, "attachment.png");
        // Another upload of the same attachment publishes between the exists check and `link`.
        const racingWith = (content: string) =>
          patchedFileSystem((fs) => ({
            link: (from, to) =>
              Effect.andThen(
                Effect.promise(() => writeFile(to, content)),
                fs.link(from, to),
              ),
          }));

        const same = yield* persistSubmissionAttachment(destination, Buffer.from("image")).pipe(
          Effect.provide(racingWith("image")),
        );
        assert.strictEqual(same, false);
        assert.deepStrictEqual(yield* listEntries(directory), ["attachment.png"]);

        yield* Effect.promise(() => rm(destination));
        const conflict = yield* persistSubmissionAttachment(destination, Buffer.from("image")).pipe(
          Effect.exit,
          Effect.provide(racingWith("other")),
        );
        assert.isTrue(Exit.isFailure(conflict));
        assert.strictEqual(yield* Effect.promise(() => readFile(destination, "utf8")), "other");
        assert.deepStrictEqual(yield* listEntries(directory), ["attachment.png"]);
      }),
    ),
  );
});
