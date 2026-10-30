import type {
  ProviderCompactState,
  ProviderControlsSnapshot,
} from "@bigbud/contracts/server/providerControls";

export const COMPACT_LABELS: Record<ProviderCompactState, string> = {
  idle: "Not started",
  submitted: "Submitted — waiting for native compaction",
  working: "Compacting context",
  completed: "Compaction complete",
  failed: "Compaction failed",
  unknown: "Compaction outcome unknown — do not automatically retry",
};
export function controlsMatch(
  snapshot: ProviderControlsSnapshot | null,
  threadId: string,
  sessionEpoch: number | undefined,
) {
  return snapshot?.threadId === threadId && snapshot.sessionEpoch === sessionEpoch;
}
export function compactTone(state: ProviderCompactState) {
  return state === "completed"
    ? "text-green-600 dark:text-green-400"
    : state === "failed"
      ? "text-red-600 dark:text-red-400"
      : state === "unknown"
        ? "text-amber-600 dark:text-amber-400"
        : state === "submitted" || state === "working"
          ? "text-blue-600 dark:text-blue-400"
          : "text-muted-foreground";
}
