import { Effect, FileSystem, Random } from "effect";
import { ServerConfig } from "../startup/config";

/** Returns the persisted random installation identifier, creating it when needed. */
export const getTelemetryIdentifier = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;
  return yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(anonymousIdPath, randomId);
        return randomId;
      }),
    ),
  );
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
