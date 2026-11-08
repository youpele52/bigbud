import type { TimestampFormat } from "@bigbud/contracts/settings";
import { useLocalDay } from "../../../hooks/useLocalDay";
import { formatTimestamp } from "../../../utils/timestamp/timestamp.utils";

export function ChatTimestamp({
  createdAt,
  timestampFormat,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
}) {
  const day = useLocalDay();
  return <>{formatTimestamp(createdAt, timestampFormat, new Date(day))}</>;
}
