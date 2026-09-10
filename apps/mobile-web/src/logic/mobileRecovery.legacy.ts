import type { ThreadId } from "@bigbud/contracts";

import type { MobileRecoveryBaseline } from "@bigbud/contracts/server/mobile.recovery";

import type { RecoveryClient } from "./mobileRecovery.types";

function isExplicitMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\s+(?:was\s+)?not found(?:\s+in orchestration snapshot)?/i.test(message);
}

export async function readLegacyMobileBaseline(input: {
  readonly client: RecoveryClient;
  readonly recoveryAttemptId: string;
  readonly selectedThreadId: ThreadId | null;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
}): Promise<MobileRecoveryBaseline> {
  const snapshot = await input.client.getSnapshot(input.signal);
  if (!input.isCurrent()) throw new Error("Mobile recovery attempt was superseded.");

  let selectedThread: MobileRecoveryBaseline["selectedThread"] = null;
  if (input.selectedThreadId !== null) {
    try {
      selectedThread = {
        status: "present",
        thread: await input.client.getMobileThread(input.selectedThreadId, input.signal),
      };
    } catch (error) {
      if (!isExplicitMissingThreadError(error)) throw error;
      selectedThread = { status: "missing" };
    }
  }
  if (!input.isCurrent()) throw new Error("Mobile recovery attempt was superseded.");
  return {
    version: 1,
    recoveryAttemptId: input.recoveryAttemptId,
    serverEpoch: "legacy",
    snapshotSequence: snapshot.snapshotSequence,
    snapshot,
    selectedThread,
  };
}
