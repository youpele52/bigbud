import type { TimestampFormat } from "@bigbud/contracts/settings";
import { formatHumanReadableDate, formatShortTimestamp } from "~/utils/timestamp";

/** Timestamp shown in an `ActivityAccordion` header's `meta` slot. */
export function ActivityAccordionTime(props: {
  readonly dateTime: string;
  readonly timestampFormat: TimestampFormat;
}) {
  return (
    <time dateTime={props.dateTime} title={formatHumanReadableDate(props.dateTime, "date-time")}>
      {formatShortTimestamp(props.dateTime, props.timestampFormat)}
    </time>
  );
}
