import { Schema } from "effect";
import { providerAttachmentPolicy } from "@bigbud/shared/providerAttachments";
import { ProviderTurnAdmissionConflict } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import {
  OpencodeV2SharedBindingConflict,
  V2_SHARED_BINDING_CONFLICT_DETAILS,
} from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { V2AdmissionUnconfirmed } from "./Admission.ts";
import { V2HttpStatusError } from "./Client.errors.ts";
import { V2ResponseSizeError } from "./Client.response.ts";

/** Only local classifications escape the adapter; native SDK causes may contain credentials. */
export function v2ExecutionIssue(error: unknown): string {
  if (Schema.is(V2AdmissionUnconfirmed)(error) || Schema.is(ProviderTurnAdmissionConflict)(error))
    return error.detail;
  if (
    Schema.is(OpencodeV2SharedBindingConflict)(error) &&
    Object.values(V2_SHARED_BINDING_CONFLICT_DETAILS).some((detail) => detail === error.detail)
  )
    return `V2 ${error.detail}`;
  if (error instanceof V2HttpStatusError || error instanceof V2ResponseSizeError)
    return error.message;
  if (
    error instanceof Error &&
    error.name === "Error" &&
    (/^(V2 |OpenCode v2 )/.test(error.message) ||
      error.message === providerAttachmentPolicy("opencodeV2").unavailableReason)
  )
    return error.message.slice(0, 512);
  return "OpenCode v2 operation failed or remains unconfirmed; no automatic resend or provider fallback.";
}
