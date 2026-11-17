import type {
  MobileOwnerRefusalCode,
  MobileOwnerStatus,
} from "../remote-backend/mobileOwnerActivation.protocol.ts";
import type { MobileOwnerReply } from "./cli.mobile.owner.client.ts";

/** Fixed client text per refusal code; server prose and private values are never echoed. */
export const mobileOwnerRefusalText: Record<MobileOwnerRefusalCode, string> = {
  "invalid-request": "The backend refused the request as malformed.",
  "authority-mismatch": "The authority does not match this account's running backend.",
  unavailable:
    "Mobile control is unavailable. The backend must run in remote mode on Linux with its account authority claimed.",
  "stale-revision": "Mobile consent changed concurrently. Check status and retry.",
  "not-installed": "The remote agent is not installed for this backend. Run backend setup first.",
  uncertain:
    "The native mobile gateway state is uncertain. Check status; an uncertain gateway is never relaunched.",
};

const unreachableText =
  "Could not reach this account's backend owner socket. Check the authority and that the backend is running.";

export function formatMobileOwnerStatus(status: MobileOwnerStatus): string {
  const { controller, consent, inputs } = status;
  const outcome = controller.lastOutcome
    ? `${controller.lastOutcome.kind}${controller.lastOutcome.repairRequired ? " (repair required)" : ""} at ${controller.lastOutcome.at}`
    : "none";
  const flags = [controller.retiring && "retiring", controller.stopping && "stopping"].filter(
    Boolean,
  );
  return [
    `Authority: ${status.authorityId}`,
    `Controller: ${
      controller.attached ? `attached, phase ${controller.phase ?? "unknown"}` : "not attached"
    }${flags.length ? ` (${flags.join(", ")})` : ""}`,
    `Last outcome: ${outcome}`,
    `Consent: ${
      consent.state === "unavailable"
        ? "unavailable"
        : `${consent.state} (revision ${consent.revision})`
    }`,
    `Proof inputs: ${inputs.state}${inputs.reason ? ` (${inputs.reason})` : ""}`,
    `Settings mobile access: ${status.settingsEnabled ? "on" : "off"}`,
  ].join("\n");
}

/** Writes either JSON or human text; any refusal or transport failure sets exit code 1. */
export function writeMobileOwnerReply<A>(
  json: boolean,
  reply: MobileOwnerReply<A> | null,
  human: (value: A) => string,
  succeeded: (value: A) => boolean = () => true,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(reply ?? { ok: false, error: "unreachable" }, null, 2)}\n`,
    );
  } else if (reply?.ok) {
    process.stdout.write(`${human(reply.value)}\n`);
  } else {
    process.stderr.write(
      `bigbud mobile: ${reply ? mobileOwnerRefusalText[reply.refused] : unreachableText}\n`,
    );
  }
  if (!reply?.ok || !succeeded(reply.value)) process.exitCode = 1;
}
