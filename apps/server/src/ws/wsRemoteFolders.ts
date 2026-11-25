import {
  ServerListRemoteFoldersError,
  type ServerListRemoteFoldersInput,
  type ServerListRemoteFoldersResult,
} from "@bigbud/contracts/server/server.remoteFolders";
import { Effect, Schema } from "effect";

import { listRemoteFolders } from "../ssh/sshRemoteFolders.ts";

const isFolderError = Schema.is(ServerListRemoteFoldersError);

/** Plain-SSH folder listing for the remote-project picker; read-only. */
export const listRemoteFoldersEffect = Effect.fn("listRemoteFoldersEffect")(function* (
  input: ServerListRemoteFoldersInput,
  run: (
    input: ServerListRemoteFoldersInput,
    signal: AbortSignal,
  ) => Promise<ServerListRemoteFoldersResult> = (request) => listRemoteFolders(request),
) {
  return yield* Effect.tryPromise({
    try: (signal) => run(input, signal),
    catch: (cause) =>
      isFolderError(cause)
        ? cause
        : new ServerListRemoteFoldersError({
            message:
              cause instanceof Error && cause.message.trim()
                ? cause.message.trim()
                : "Failed to list remote folders.",
            cause,
          }),
  });
});
