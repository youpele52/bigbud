import { Effect, FileSystem, Path } from "effect";

/** Publish complete immutable uploads; a retry must not truncate an accepted blob. */
export const persistSubmissionAttachment = Effect.fn("persistSubmissionAttachment")(function* (
  destination: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const verifyExisting = fs
    .readFile(destination)
    .pipe(
      Effect.flatMap((existing) =>
        Buffer.from(existing).equals(Buffer.from(bytes))
          ? Effect.void
          : Effect.fail(
              new Error("Stored submission attachment does not match its content identity."),
            ),
      ),
    );
  if (yield* fs.exists(destination)) return yield* verifyExisting;
  yield* Effect.acquireUseRelease(
    fs.makeTempFile({ directory: path.dirname(destination), prefix: ".submission-upload-" }),
    (temporary) =>
      fs.writeFile(temporary, bytes).pipe(
        Effect.andThen(fs.link(temporary, destination)),
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? verifyExisting : Effect.fail(error),
        ),
      ),
    (temporary) => fs.remove(temporary).pipe(Effect.ignore),
  );
});
