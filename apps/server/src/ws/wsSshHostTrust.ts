import { Effect } from "effect";
import {
  ServerTrustSshHostError,
  type ServerTrustSshHostInput,
} from "@bigbud/contracts/server/server.sshHostTrust";

import { trustProductionSshHost } from "../ssh/sshOwnerProductionPicker.ts";

export const trustSshHostEffect = Effect.fn("trustSshHostEffect")(
  (input: ServerTrustSshHostInput) =>
    Effect.tryPromise({
      try: () => trustProductionSshHost(input),
      catch: (cause) =>
        new ServerTrustSshHostError({
          message: cause instanceof Error ? cause.message : "Failed to trust the SSH server.",
          cause,
        }),
    }),
);
