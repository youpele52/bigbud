import {
  MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH,
  type MobileRecoveryFrame,
} from "@bigbud/contracts/server/mobile.recovery";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

export const MOBILE_RECOVERY_MAX_BATCH_BYTES = 256 * 1024;

export const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function batchFrames(
  input: { readonly recoveryAttemptId: string; readonly serverEpoch: string },
  events: ReadonlyArray<OrchestrationEvent>,
): Array<MobileRecoveryFrame> | null {
  if (events.length === 0) return [];

  const frames: Array<MobileRecoveryFrame> = [];
  let current: OrchestrationEvent[] = [];
  const flush = () => {
    if (current.length === 0) return;
    frames.push({
      version: 1,
      type: "batch",
      route: "direct-unmanaged",
      recoveryAttemptId: input.recoveryAttemptId,
      serverEpoch: input.serverEpoch,
      batchId: `mobile-recovery-${current[0]!.sequence}-${current.at(-1)!.sequence}`,
      events: current,
    });
    current = [];
  };

  for (const event of events) {
    if (current.length >= MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH) flush();
    const singleEventFrame = {
      version: 1,
      type: "batch" as const,
      route: "direct-unmanaged" as const,
      recoveryAttemptId: input.recoveryAttemptId,
      serverEpoch: input.serverEpoch,
      batchId: `mobile-recovery-${event.sequence}-${event.sequence}`,
      events: [event],
    } satisfies MobileRecoveryFrame;
    if (serializedBytes(singleEventFrame) > MOBILE_RECOVERY_MAX_BATCH_BYTES) return null;
    const candidate = [...current, event];
    const candidateFrame = {
      version: 1,
      type: "batch" as const,
      route: "direct-unmanaged" as const,
      recoveryAttemptId: input.recoveryAttemptId,
      serverEpoch: input.serverEpoch,
      batchId: `mobile-recovery-${candidate[0]!.sequence}-${candidate.at(-1)!.sequence}`,
      events: candidate,
    } satisfies MobileRecoveryFrame;
    if (
      (candidate.length > MOBILE_RECOVERY_MAX_EVENTS_PER_BATCH ||
        serializedBytes(candidateFrame) > MOBILE_RECOVERY_MAX_BATCH_BYTES) &&
      current.length > 0
    ) {
      flush();
      current = [event];
    } else {
      current = candidate;
    }
  }
  flush();
  return frames;
}
