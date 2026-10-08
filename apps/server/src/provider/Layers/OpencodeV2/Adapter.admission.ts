import type { SessionInboxUser } from "@opencode/client";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@bigbud/contracts/orchestration/orchestration.provider";
import { Effect } from "effect";

import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";
import { V2AdmissionUnconfirmed } from "./Admission.ts";

/** This development transport explicitly does not execute models or tools. */
export function makeNoExecutionAdmissionTransport(client: OpencodeV2Client, text: string) {
  const validText = text.trim().length > 0 && text.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  const correlated = (row: ProviderTurnAdmission, native: SessionInboxUser) =>
    native.type === "user" &&
    native.id === row.nativeAdmissionId &&
    native.sessionID === row.binding.nativeSessionId &&
    native.delivery === "queue" &&
    native.payload.text === text &&
    !native.payload.files?.length &&
    !native.payload.agents?.length &&
    !native.payload.skills?.length;
  const failure = () =>
    new V2AdmissionUnconfirmed({
      detail: "OpenCode v2 delivery is unconfirmed; no resend is permitted.",
    });
  return {
    dispatch: (row: ProviderTurnAdmission) =>
      !validText
        ? Effect.fail(failure())
        : Effect.tryPromise({
            try: async () =>
              correlated(
                row,
                await v2Request("session.prompt", (signal) =>
                  client.session.prompt(
                    {
                      sessionID: row.binding.nativeSessionId,
                      id: row.nativeAdmissionId,
                      text,
                      resume: false,
                      delivery: "queue",
                    },
                    { signal },
                  ),
                ),
              ),
            catch: failure,
          }),
    reconcile: (row: ProviderTurnAdmission) =>
      !validText
        ? Effect.fail(failure())
        : Effect.tryPromise({
            try: async (): Promise<"accepted" | "unknown"> => {
              const inbox = await v2Request("session.inbox.list", (signal) =>
                client.session.inbox.list({ sessionID: row.binding.nativeSessionId }, { signal }),
              );
              const admitted = inbox.find((item) => item.id === row.nativeAdmissionId);
              // Absence here is not proof of no admission: projected inputs can leave the inbox.
              return admitted?.type === "user" && correlated(row, admitted)
                ? "accepted"
                : "unknown";
            },
            catch: failure,
          }),
  };
}
