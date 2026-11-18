import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import {
  activateMobileOwner,
  enableMobileOwnerConsent,
  readMobileOwnerStatus,
  repairMobileOwner,
  resolveMobileOwner,
  stopMobileOwner,
  type MobileOwnerReply,
} from "./cli.mobile.owner.client.ts";
import {
  formatMobileOwnerRepair,
  formatMobileOwnerResolve,
  formatMobileOwnerStatus,
  mobileActivationReasonGuidance,
  writeMobileOwnerReply,
} from "./cli.mobile.owner.format.ts";

const authority = () =>
  Flag.string("authority").pipe(
    Flag.withSchema(RemoteBackendAuthorityId),
    Flag.withDescription("This account's backend authority id (32 lowercase hex)."),
  );
const json = () => Flag.boolean("json").pipe(Flag.withDescription("Print the reply as JSON."));
const run = <A>(
  asJson: boolean,
  request: () => Promise<MobileOwnerReply<A>>,
  human: (value: A) => string,
  succeeded?: (value: A) => boolean,
) =>
  Effect.promise(async () =>
    writeMobileOwnerReply(asJson, await request().catch(() => null), human, succeeded),
  );
const started = (status: string) => status === "accepted" || status === "selected";

const enable = Command.make("enable", {
  authorityId: authority(),
  confirmConsent: Flag.boolean("confirm-consent").pipe(
    Flag.withDescription("Required: grant durable mobile consent for this account's backend."),
  ),
  json: json(),
}).pipe(
  Command.withDescription(
    "Grant durable mobile consent and turn settings mobile access on. Turning that setting off revokes.",
  ),
  Command.withHandler((input) =>
    !input.confirmConsent
      ? Effect.sync(() => {
          process.stderr.write(
            "bigbud mobile: enable grants durable mobile consent and requires --confirm-consent.\n",
          );
          process.exitCode = 1;
        })
      : run(
          input.json,
          () => enableMobileOwnerConsent(input.authorityId),
          (result) =>
            result.changed
              ? `Mobile consent granted (revision ${result.revision}); settings mobile access is on. Gateways from earlier grants can only be revoked.`
              : `Mobile consent was already granted (revision ${result.revision}); settings mobile access is on.`,
        ),
  ),
);

const notStarted: Record<string, string> = {
  disabled: "mobile consent is disabled; run bigbud mobile enable --confirm-consent",
  retired: "the controller retired",
  unavailable:
    "no mobile controller is attached or it is busy or uncertain (see bigbud mobile status)",
  failed: "it failed before native Start; the controller is unchanged",
};
const activate = Command.make("activate", {
  authorityId: authority(),
  externalOrigin: Flag.string("origin").pipe(
    Flag.withDescription("Canonical HTTPS origin the gateway is reached at, without a path."),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Fixed loopback port for the native gateway."),
  ),
  json: json(),
}).pipe(
  Command.withDescription("Ask the attached mobile controller to start the native gateway."),
  Command.withHandler((input) =>
    run(
      input.json,
      () =>
        activateMobileOwner(input.authorityId, {
          externalOrigin: input.externalOrigin,
          port: input.port,
        }),
      (ack) =>
        started(ack.status)
          ? `Activation ${ack.status} (request ${ack.requestId}). This is not readiness; check status.`
          : `Activation not started: ${notStarted[ack.status] ?? ack.status}${ack.reason ? ` (${ack.reason})` : ""}.${
              ack.reason && mobileActivationReasonGuidance[ack.reason]
                ? ` ${mobileActivationReasonGuidance[ack.reason]}`
                : ""
            }`,
      // Only an accepted acknowledgement is success; every other status started nothing.
      (ack) => started(ack.status),
    ),
  ),
);

const stop = Command.make("stop", { authorityId: authority(), json: json() }).pipe(
  Command.withDescription("Stop the native gateway the attached controller owns, confirming exit."),
  Command.withHandler((input) =>
    run(
      input.json,
      () => stopMobileOwner(input.authorityId),
      () => "Mobile gateway stopped (or nothing was running).",
    ),
  ),
);

const status = Command.make("status", { authorityId: authority(), json: json() }).pipe(
  Command.withDescription("Show mobile controller phase, consent, proof inputs and last outcome."),
  Command.withHandler((input) =>
    run(input.json, () => readMobileOwnerStatus(input.authorityId), formatMobileOwnerStatus),
  ),
);

const repair = Command.make("repair", {
  authorityId: authority(),
  resolve: Flag.boolean("resolve").pipe(
    Flag.withDescription(
      "First settle gateway rows whose native supervisor provably ended (prior boot or settled exit).",
    ),
  ),
  json: json(),
}).pipe(
  Command.withDescription(
    "Remove runtime-asset trees the journal proves unowned; report what was kept and why.",
  ),
  Command.withHandler((input) =>
    input.resolve
      ? run(input.json, () => resolveMobileOwner(input.authorityId), formatMobileOwnerResolve)
      : run(input.json, () => repairMobileOwner(input.authorityId), formatMobileOwnerRepair),
  ),
);

export const mobileOwnerCommands = [enable, activate, stop, status, repair] as const;
