import { formatRelativeTimeLabel } from "../../utils/timestamp";

function normalizeElevatorSummaryText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

/** The elevator summary when it adds something beyond the title. */
export function threadHoverSummary(thread: {
  readonly title: string;
  readonly elevatorSummary?: string | null | undefined;
}): string | null {
  const summary = normalizeElevatorSummaryText(thread.elevatorSummary);
  return summary.length > 0 && summary !== normalizeElevatorSummaryText(thread.title)
    ? summary
    : null;
}

/**
 * The hover card's terminal line: a label and the time, formatted like the row's own time label
 * ("2h", "just now") so the card can align it to the right. Null without terminal activity.
 */
export function terminalActivityHoverLine(
  latestTerminalActivityAt: string | null | undefined,
): { readonly label: string; readonly time: string } | null {
  if (!latestTerminalActivityAt || !Number.isFinite(Date.parse(latestTerminalActivityAt)))
    return null;
  return {
    label: "Last terminal activity",
    time: formatRelativeTimeLabel(latestTerminalActivityAt),
  };
}
