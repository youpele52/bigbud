import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Schema } from "effect";
import { providerAttachmentPolicy } from "@bigbud/shared/providerAttachments";
import { ProviderTurnAdmissionConflict } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import {
  OpencodeV2SharedBindingConflict,
  V2_SHARED_BINDING_CONFLICT_DETAILS,
} from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { V2AdmissionUnconfirmed } from "./Admission.ts";
import { V2HttpStatusError, v2HttpFailureStatus } from "./Client.errors.ts";
import { V2ResponseSizeError } from "./Client.response.ts";
import { V2SavedPermissionConflict } from "./Runtime.permissions.saved.ts";

/** Only local classifications escape the adapter; native SDK causes may contain credentials. */
export function v2ExecutionIssue(error: unknown): string {
  if (error instanceof V2SavedPermissionConflict) return error.message;
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

/**
 * Turn-start class for a V2 failure. V2 never resends automatically, so anything that is not a
 * provable auth, request or busy failure is `unsafe-to-replay` (user action, no auto-recovery).
 */
export function v2ExecutionFailureClass(error: unknown, issue: string): TurnStartFailureClass {
  if (error instanceof V2SavedPermissionConflict) return "invalid-request";
  const status = v2HttpFailureStatus(error);
  if (status === 401 || status === 402 || status === 403 || status === 429) return "auth-or-quota";
  if (issue === providerAttachmentPolicy("opencodeV2").unavailableReason) return "invalid-request";
  if (/already active/i.test(issue)) return "busy";
  return "unsafe-to-replay";
}
