import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { MobileRemoteControlScope } from "@bigbud/contracts/server/mobile";
import { createMobileOwnerPairing } from "./cli.mobile.client.ts";

const pair = Command.make("pair", {
  authorityId: Flag.string("authority").pipe(Flag.withSchema(RemoteBackendAuthorityId)),
  backendOrigin: Flag.string("origin").pipe(
    Flag.withDescription("This host's private HTTPS origin, without path, query or credentials."),
  ),
  scope: Flag.choice("scope", MobileRemoteControlScope.literals),
}).pipe(
  Command.withDescription(
    "Create a short-lived pairing link through this account's authenticated backend owner socket.",
  ),
  Command.withHandler((input) =>
    Effect.promise(async () => {
      try {
        const result = await createMobileOwnerPairing(input);
        process.stdout.write(
          `Authority: ${input.authorityId}\nScope: ${result.scope}\nExpires: ${result.expiresAt}\n${result.pairUrl}\n`,
        );
      } catch {
        process.stderr.write(
          "bigbud mobile: Pairing unavailable. Verify the authority, HTTPS origin and mobile readiness.\n",
        );
        process.exitCode = 1;
      }
    }),
  ),
);
export const mobileCommand = Command.make("mobile").pipe(
  Command.withDescription("Manage optional mobile access on this remote host."),
  Command.withSubcommands([pair]),
);
