import { Effect } from "effect";
import {
  ServerTrustSshHostError,
  type ServerTrustSshHostInput,
} from "@bigbud/contracts/server/server.sshHostTrust";

import { trustSshHost } from "../ssh/sshHostTrust.ts";

export const trustSshHostEffect = Effect.fn("trustSshHostEffect")(
  (input: ServerTrustSshHostInput) =>
    Effect.tryPromise({
      try: () => trustSshHost(input),
      catch: (cause) =>
        new ServerTrustSshHostError({
          message: cause instanceof Error ? cause.message : "Failed to trust the SSH server.",
          cause,
        }),
    }),
);
