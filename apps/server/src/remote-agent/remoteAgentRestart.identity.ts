import { createHash } from "node:crypto";

/** Shared identity for canonical P4 replacement reservations and crash recovery. */
export function remoteAgentRestartAttemptId(requestId: string): string {
  return `restart-${createHash("sha256").update(requestId).digest("hex").slice(0, 48)}`;
}
