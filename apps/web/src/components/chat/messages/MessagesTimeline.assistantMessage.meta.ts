import { type TimestampFormat } from "@bigbud/contracts/settings";

import { formatTimestamp } from "../../../utils/timestamp";

export { formatWorkingTimer } from "@bigbud/ui/formatWorkingTimer";

export function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
  now: Date = new Date(),
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat, now);
  return `${formatTimestamp(createdAt, timestampFormat, now)} • ${duration}`;
}
