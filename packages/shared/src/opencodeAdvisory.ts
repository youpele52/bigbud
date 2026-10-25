/** Stable advisory identity; dismissal is independent of thread, service version and status text. */
export const OPENCODE_RETAINED_HISTORY_ADVISORY_ID = "opencode-retained-native-history";

export const OPENCODE_RETAINED_HISTORY_ADVISORY =
  "Logical native history is retained. Do not run shared execution in an older build without shared-binding recovery. Before downgrade, durably disable OpenCode v2, drain bigbud and stop the application; preserve all binding/admission records and attachments. Native service shutdown is not required.";

/** Actionable notice for a native service older than the version bigbud supports. */
export function opencodeUpdateAdvice(current: string, supported: string): string {
  return `OpenCode ${current} is older than ${supported}, the version bigbud supports. Run "opencode upgrade", then restart your OpenCode service; it stays usable until then.`;
}

/** Match only the complete authored suffix, never a substring inside a primary error. */
export function getRetainedHistoryAdvisory(status: ServerProvider | null) {
  if (status?.provider !== "opencodeV2") return null;
  const message = status.message?.trim() ?? "";
  const suffix = ` ${OPENCODE_RETAINED_HISTORY_ADVISORY}`;
  if (message !== OPENCODE_RETAINED_HISTORY_ADVISORY && !message.endsWith(suffix)) return null;
  const primaryMessage = message.slice(0, -OPENCODE_RETAINED_HISTORY_ADVISORY.length).trim();
  const advisoryOnly =
    status.status === "warning" &&
    status.enabled &&
    status.installed &&
    status.initialProbeComplete !== false &&
    !status.failure &&
    status.auth.status !== "unauthenticated" &&
    status.recovery?.status !== "retrying" &&
    (primaryMessage === "" || primaryMessage === "Connected to your native OpenCode service.");
  return { primaryMessage, advisoryOnly };
}
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
