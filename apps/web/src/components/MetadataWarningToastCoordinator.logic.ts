import type { MetadataGenerationWarning } from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";
import {
  METADATA_WARNING_CLAIM_MS,
  type MetadataWarningsNativeApi,
} from "@bigbud/contracts/server/metadataWarnings.ts";

/** Delivery retries only; this object has no capability to create or retry generation jobs. */
export function createMetadataWarningDelivery(clientId: string) {
  const shown = new Set<string>();
  let polling = false;
  return {
    async poll(
      api: MetadataWarningsNativeApi,
      show: (warning: MetadataGenerationWarning) => void,
      isActive: () => boolean,
    ): Promise<void> {
      if (polling || !isActive()) return;
      polling = true;
      try {
        // Include network/queue time and sleep (some platforms pause performance.now).
        // Both clocks are local; clock rollback refuses display rather than extending a lease.
        const startedAt = performance.now();
        const wallStartedAt = Date.now();
        const warnings = await api.claimMetadataWarnings({ clientId });
        for (const warning of warnings) {
          const elapsed = performance.now() - startedAt;
          const wallElapsed = Date.now() - wallStartedAt;
          if (
            !isActive() ||
            elapsed < 0 ||
            wallElapsed < 0 ||
            Math.max(elapsed, wallElapsed) >= METADATA_WARNING_CLAIM_MS
          )
            return;
          if (!shown.has(warning.id)) {
            show(warning);
            shown.add(warning.id);
            // Bound renderer memory. The server returns the oldest unacknowledged page first.
            if (shown.size > 100) shown.delete(shown.values().next().value!);
          }
          // An unavailable or lost acknowledgment leaves the row pending. The same consumer
          // renews its lease and retries acknowledgment without another toast on reconnect.
          await api.acknowledgeMetadataWarning({ clientId, warningId: warning.id }).catch(() => {});
        }
      } finally {
        polling = false;
      }
    },
  };
}

export function metadataWarningToast(
  warning: MetadataGenerationWarning,
  openSettings: () => void,
  renameThread: () => void = () => {},
) {
  const final = warning.kind === "final";
  const titleFailure = warning.operation === "title";
  return {
    id: warning.id,
    type: "warning" as const,
    title: final
      ? titleFailure
        ? "This thread couldn't be named automatically. Rename it, or ask the agent in the thread to do it."
        : "This thread's summary couldn't be created automatically. Ask the agent in the thread to write one."
      : "Text generation model needs attention",
    ...(!final
      ? {
          description:
            warning.primaryFailures >= 2
              ? "Your configured text generation model exhausted its attempts to generate thread metadata. Review your AI settings. Recovery may use the thread model."
              : "Your configured text generation model cannot currently be used for thread metadata. Review your AI settings. Recovery may use the thread model.",
        }
      : {}),
    timeout: 0,
    data: { hideCopyButton: true },
    actionProps: final
      ? titleFailure
        ? { children: "Rename", onClick: renameThread }
        : undefined
      : { children: "Review AI settings", onClick: openSettings },
  };
}
