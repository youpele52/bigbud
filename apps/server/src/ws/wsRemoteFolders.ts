import {
  ServerListRemoteFoldersError,
  type ServerListRemoteFoldersInput,
} from "@bigbud/contracts/server/server.remoteFolders";
import { Effect } from "effect";

import { listRemoteFolders } from "../ssh/sshRemoteFolders.ts";

/** Plain-SSH folder listing for the remote-project picker; read-only. */
export const listRemoteFoldersEffect = Effect.fn("listRemoteFoldersEffect")(function* (
  input: ServerListRemoteFoldersInput,
) {
  return yield* Effect.tryPromise({
    try: () => listRemoteFolders(input),
    catch: (cause) =>
      new ServerListRemoteFoldersError({
        message:
          cause instanceof Error && cause.message.trim()
            ? cause.message.trim()
            : "Failed to list remote folders.",
        cause,
      }),
  });
});
