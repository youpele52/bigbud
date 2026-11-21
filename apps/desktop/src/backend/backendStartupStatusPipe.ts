import type { Readable } from "node:stream";

import { acknowledgeBackendLifecycleHint } from "./backendLifecycleHintPipe";
import { recordBackendStartupProgress, recordBackendStartupStatus } from "./backendStartupState";
import type { DesktopBackendStartupFailureReason } from "@bigbud/contracts/server/ipc.desktop.ts";

const MAX_STARTUP_STATUS_BUFFER_LENGTH = 16 * 1024;
const failureReasons = new Set<DesktopBackendStartupFailureReason>([
  "bootstrap_failed",
  "state_directory_in_use",
  "state_directory_owner_unverified",
  "projection_database_initialization_failed",
  "server_runtime_startup_failed",
  "unknown",
]);

/**
 * Key of the server's `DesktopLifecycleHintAck` record on this pipe:
 * `{"lifecycleHintAck":{"sequence":7}}`. Must equal the server's
 * `DESKTOP_LIFECYCLE_HINT_ACK_RECORD_KEY`.
 */
export const LIFECYCLE_HINT_ACK_RECORD_KEY = "lifecycleHintAck";

/** The acked sequence of an ack record, or null when the record is not a valid ack. */
export function readLifecycleHintAckSequence(record: object): number | null {
  const ack: unknown = (record as Record<string, unknown>)[LIFECYCLE_HINT_ACK_RECORD_KEY];
  if (typeof ack !== "object" || ack === null) return null;
  const { sequence } = ack as { sequence?: unknown };
  return typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 0
    ? sequence
    : null;
}

function isFailureReason(value: unknown): value is DesktopBackendStartupFailureReason {
  return (
    typeof value === "string" && failureReasons.has(value as DesktopBackendStartupFailureReason)
  );
}

export function listenForBackendStartupStatus(
  stream: Readable | null,
  generation: number,
  onInvalidRecord?: (detail: string) => void,
  onReady?: () => void,
): void {
  if (!stream) return;
  let buffered = "";
  let discardingOversizedLine = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let input = chunk;
    while (input.length > 0) {
      if (discardingOversizedLine) {
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        input = input.slice(newline + 1);
        discardingOversizedLine = false;
        continue;
      }

      const newline = input.indexOf("\n");
      const fragmentLength = newline < 0 ? input.length : newline;
      if (buffered.length + fragmentLength > MAX_STARTUP_STATUS_BUFFER_LENGTH) {
        buffered = "";
        console.warn("[desktop] ignored oversized backend startup status record");
        onInvalidRecord?.("oversized status record");
        if (newline < 0) {
          discardingOversizedLine = true;
          return;
        }
        input = input.slice(newline + 1);
        continue;
      }

      buffered += input.slice(0, fragmentLength);
      if (newline < 0) return;

      try {
        const payload: unknown = JSON.parse(buffered);
        if (
          typeof payload === "object" &&
          payload !== null &&
          LIFECYCLE_HINT_ACK_RECORD_KEY in payload
        ) {
          const sequence = readLifecycleHintAckSequence(payload);
          if (sequence === null) onInvalidRecord?.("malformed lifecycle hint ack");
          else acknowledgeBackendLifecycleHint(sequence);
        } else if (typeof payload === "object" && payload !== null) {
          const { progress, reason, status } = payload as {
            progress?: unknown;
            reason?: unknown;
            status?: unknown;
          };
          if (status === "error") {
            recordBackendStartupStatus(
              generation,
              status,
              isFailureReason(reason) ? reason : "unknown",
            );
          } else {
            const accepted = recordBackendStartupStatus(generation, status);
            if (accepted && status === "ready") onReady?.();
            if (status === "upgrading") recordBackendStartupProgress(generation, progress);
          }
        }
      } catch {
        console.warn("[desktop] ignored malformed backend startup status record");
        onInvalidRecord?.("malformed status record");
      }
      buffered = "";
      input = input.slice(newline + 1);
    }
  });
}
