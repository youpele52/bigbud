import {
  ServerListRemoteFoldersError,
  type ServerListRemoteFoldersInput,
  type ServerListRemoteFoldersResult,
} from "@bigbud/contracts/server/server.remoteFolders";
import { Effect, Schema } from "effect";

import { listProductionRemoteFolders } from "../ssh/sshOwnerProductionPicker.ts";

const isFolderError = Schema.is(ServerListRemoteFoldersError);

/** Folder listing for the remote-project picker through the Rust SSH owner; read-only. */
export const listRemoteFoldersEffect = Effect.fn("listRemoteFoldersEffect")(function* (
  input: ServerListRemoteFoldersInput,
  run: (
    input: ServerListRemoteFoldersInput,
    signal: AbortSignal,
  ) => Promise<ServerListRemoteFoldersResult> = listProductionRemoteFolders,
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
