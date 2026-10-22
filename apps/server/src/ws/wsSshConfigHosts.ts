import { ServerListSshConfigHostsError } from "@bigbud/contracts/server/server.sshConfig";
import { Effect } from "effect";

import { discoverSshConfigHosts } from "../ssh/sshConfigDiscovery.ts";

/** Read-only: parses SSH config files and never spawns `ssh`. */
export const listSshConfigHostsEffect = Effect.fn("listSshConfigHostsEffect")(function* () {
  return yield* Effect.tryPromise({
    try: () => discoverSshConfigHosts(),
    catch: (cause) =>
      new ServerListSshConfigHostsError({
        message:
          cause instanceof Error && cause.message.trim()
            ? `Failed to read SSH config: ${cause.message.trim()}`
            : "Failed to read SSH config.",
        cause,
      }),
  });
});
