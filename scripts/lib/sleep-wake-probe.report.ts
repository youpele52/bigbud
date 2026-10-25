import type { SleepWakeRunRow } from "./sleep-wake-probe.types.ts";

/** Column order of the results table in `docs/research/Sleep and wake provider conformance/README.md`. */
export const RESULTS_TABLE_HEADER = [
  "Date",
  "Provider",
  "Version",
  "Build",
  "Topology",
  "Scenario",
  "Planned min",
  "Slept min",
  "Resume signal (s)",
  "Socket dropped",
  "Reconnect (s)",
  "Outcome",
  "First progress (s)",
  "Ended (s)",
  "Tool ran twice",
  "Notes",
  "Run ID",
] as const;

function seconds(ms: number | null): string {
  return ms === null ? "–" : (ms / 1000).toFixed(1);
}

function cell(value: string | number | boolean | null): string {
  if (value === null) return "–";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** One Markdown table row, in `RESULTS_TABLE_HEADER` order. Times are seconds after wake. */
export function formatTableRow(row: SleepWakeRunRow): string {
  const cells = [
    row.recordedAt.slice(0, 10),
    row.provider,
    row.providerVersion,
    row.build,
    row.topology,
    row.scenario,
    row.plannedSleepMinutes,
    row.sleep.wallGapMs === null ? null : (row.sleep.wallGapMs / 60_000).toFixed(1),
    seconds(row.signals.resumeAfterWakeMs),
    row.reconnect.socketDropped,
    seconds(row.reconnect.reconnectSuccessAfterWakeMs),
    row.turn.outcome,
    seconds(row.turn.firstProgressAfterWakeMs),
    seconds(row.turn.endedAfterWakeMs),
    row.tools.ranTwice,
    row.notes.join("; ") || null,
    row.runId,
  ].map(cell);
  return `| ${cells.join(" | ")} |`;
}

export function formatTableHeader(): string {
  return [
    `| ${RESULTS_TABLE_HEADER.join(" | ")} |`,
    `| ${RESULTS_TABLE_HEADER.map(() => "---").join(" | ")} |`,
  ].join("\n");
}

/** Plain-language summary printed after each run. */
export function formatSummary(row: SleepWakeRunRow): string {
  const lines: string[] = [];
  const provider = row.provider ?? "unknown provider";
  lines.push(
    `Run ${row.runId}: ${provider} ${row.providerVersion ?? "(version unknown)"}, ${row.scenario} turn, ${row.build} build, ${row.topology}.`,
  );
  if (row.sleep.detected) {
    lines.push(
      `Slept ${seconds(row.sleep.wallGapMs)} s by the wall clock; the monotonic clock advanced ${seconds(row.sleep.monotonicGapMs)} s, so server trace times lag by ${seconds(row.sleep.serverClockDriftMs)} s after wake.`,
    );
  } else {
    lines.push("No sleep was detected. Did the lid close for at least 15 seconds?");
  }
  if (row.sleep.osSleepAt !== null) {
    lines.push(`OS log: sleep at ${row.sleep.osSleepAt}, wake at ${row.sleep.osWakeAt ?? "?"}.`);
  }
  if (row.signals.source === "unavailable") {
    lines.push("Desktop suspend and resume signals: not logged in this build.");
  } else {
    lines.push(
      `Desktop signals: suspend ${row.signals.suspendAt ?? "missing"}, resume ${seconds(row.signals.resumeAfterWakeMs)} s after wake.`,
    );
  }
  lines.push(
    row.reconnect.socketDropped
      ? `The socket dropped; reconnect succeeded ${seconds(row.reconnect.reconnectSuccessAfterWakeMs)} s after wake.`
      : "No socket drop was recorded.",
  );
  if (row.reconnect.stalls > 0) {
    lines.push(
      `${row.reconnect.stalls} server stall(s), longest ${seconds(row.reconnect.maxStallMs)} s.`,
    );
  }
  lines.push(
    `Turn outcome: ${row.turn.outcome}. First progress ${seconds(row.turn.firstProgressAfterWakeMs)} s after wake; ended ${seconds(row.turn.endedAfterWakeMs)} s after wake; last session status ${row.turn.lastSessionStatus ?? "unknown"}.`,
  );
  if (row.turn.lastError !== null) lines.push(`Last error: ${row.turn.lastError}`);
  for (const evidence of row.turn.retryEvidence) lines.push(`Retry evidence: ${evidence}`);
  lines.push(
    `Tools: ${row.tools.started} started, ${row.tools.completed} completed` +
      (row.tools.markerStarts === null
        ? "; no marker file."
        : `; marker shows ${row.tools.markerStarts} start(s) and ${row.tools.markerDones} done line(s). Ran twice: ${row.tools.ranTwice ? "YES" : "no"}.`),
  );
  for (const note of row.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
