import type { ThreadOrganizationSnooze } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { ClockIcon } from "lucide-react";

import { formatSnoozeWakeTime } from "./Sidebar.inyosira.snoozePicker";

export function SidebarThreadSnoozeIcon({
  snooze,
}: {
  snooze: ThreadOrganizationSnooze | null | undefined;
}) {
  if (!snooze) return null;
  const label = `Snoozed until ${formatSnoozeWakeTime(new Date(snooze.until))}`;

  return (
    <span
      data-slot="thread-snooze-icon"
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
    >
      <ClockIcon aria-hidden="true" focusable="false" className="size-3" />
    </span>
  );
}
