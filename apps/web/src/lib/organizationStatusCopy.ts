import { ORGANIZATION_THREAD_LIMIT } from "@bigbud/contracts/constants/organization.constant.ts";
import type { OrganizationAutomationStatus } from "@bigbud/contracts/server/organizationAutomation.ts";

const THREAD_LIMIT = ORGANIZATION_THREAD_LIMIT.toLocaleString("en-US");

/** One user-facing explanation of a paused organiser, shared by the sidebar and Settings.
 * Each variant names how it recovers; manual moves are never affected.
 */
export function organizationPausedCopy(
  status: OrganizationAutomationStatus | undefined,
): string | null {
  if (status?.state !== "paused") return null;
  switch (status.reason) {
    case "thread-limit":
      return `Automatic organisation stopped: there are more than ${THREAD_LIMIT} threads to organise. You can still move threads. After deleting some, change any Inyosira setting to try again.`;
    case "capture-time":
      return "Automatic organisation stopped: reading your threads took too long. You can still move threads. Change any Inyosira setting to try again.";
    default:
      return "Automatic organisation is paused. You can still move threads. It retries on its own, or right away when you move a thread or change Inyosira settings.";
  }
}
