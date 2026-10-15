import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import {
  OPENCODE_RETAINED_HISTORY_ADVISORY,
  OPENCODE_UNQUALIFIED_RUNTIME_WARNING,
} from "@bigbud/shared/opencodeAdvisory";

/** Only the exact informational notice can be cleared; qualification is never promoted. */
export function withoutVerifiedRuntimeNotice(status: ServerProvider | null, verified: boolean) {
  if (
    !verified ||
    status?.provider !== "opencodeV2" ||
    status.status !== "warning" ||
    !status.enabled ||
    !status.installed ||
    status.initialProbeComplete === false ||
    status.failure ||
    status.auth.status === "unauthenticated" ||
    status.recovery?.status === "retrying"
  )
    return status;
  const connected = "Connected to your native OpenCode service.";
  const notice = `${connected} ${OPENCODE_UNQUALIFIED_RUNTIME_WARNING}`;
  if (status.message === notice) return null;
  if (status.message === `${notice} ${OPENCODE_RETAINED_HISTORY_ADVISORY}`)
    return { ...status, message: `${connected} ${OPENCODE_RETAINED_HISTORY_ADVISORY}` };
  return status;
}
