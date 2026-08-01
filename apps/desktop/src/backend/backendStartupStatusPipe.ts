import type { Readable } from "node:stream";

import { recordBackendStartupStatus } from "./backendStartupState";
import type { DesktopBackendStartupFailureReason } from "@bigbud/contracts/server/ipc.desktop.ts";

const MAX_STARTUP_STATUS_BUFFER_LENGTH = 16 * 1024;
const failureReasons = new Set<DesktopBackendStartupFailureReason>([
  "bootstrap_failed",
  "projection_database_initialization_failed",
  "server_runtime_startup_failed",
  "unknown",
]);

function isFailureReason(value: unknown): value is DesktopBackendStartupFailureReason {
  return (
    typeof value === "string" && failureReasons.has(value as DesktopBackendStartupFailureReason)
  );
}

export function listenForBackendStartupStatus(
  stream: Readable | null,
  generation: number,
  onInvalidRecord?: (detail: string) => void,
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
        if (typeof payload === "object" && payload !== null) {
          const { reason, status } = payload as { reason?: unknown; status?: unknown };
          if (status === "error") {
            recordBackendStartupStatus(
              generation,
              status,
              isFailureReason(reason) ? reason : "unknown",
            );
          } else {
            recordBackendStartupStatus(generation, status);
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
