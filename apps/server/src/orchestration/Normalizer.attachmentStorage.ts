import { Effect, FileSystem, Path } from "effect";

import {
  SUBMISSION_UPLOAD_DIRECTORY_PREFIX,
  SUBMISSION_UPLOAD_STAGED_FILE_NAME,
} from "../attachments/attachmentMaintenance.layout.ts";

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
          ? Effect.succeed(false)
          : Effect.fail(
              new Error("Stored submission attachment does not match its content identity."),
            ),
      ),
    );
  if (yield* fs.exists(destination)) return yield* verifyExisting;
  // The staging directory sits beside the destination so `link` stays on one filesystem; it is
  // removed whole, because a temp file's own directory would otherwise be left behind.
  return yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({
      directory: path.dirname(destination),
      prefix: SUBMISSION_UPLOAD_DIRECTORY_PREFIX,
    }),
    (stagingDirectory) => {
      const temporary = path.join(stagingDirectory, SUBMISSION_UPLOAD_STAGED_FILE_NAME);
      return fs.writeFile(temporary, bytes).pipe(
        Effect.andThen(fs.link(temporary, destination)),
        Effect.as(true),
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? verifyExisting : Effect.fail(error),
        ),
      );
    },
    (stagingDirectory) => fs.remove(stagingDirectory, { recursive: true }).pipe(Effect.ignore),
  );
});
