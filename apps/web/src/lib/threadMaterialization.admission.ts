import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

export const pendingThreadCreations = new Map<ThreadId, Promise<void>>();
const confirmedTerminalOwners = new Set<ThreadId>();
const MAX_RECENT_TERMINAL_OWNERS = 1024;

export function markTerminalOwnerConfirmed(threadId: ThreadId): void {
  confirmedTerminalOwners.add(threadId);
  if (confirmedTerminalOwners.size > MAX_RECENT_TERMINAL_OWNERS) {
    const oldest = confirmedTerminalOwners.values().next().value;
    if (oldest) confirmedTerminalOwners.delete(oldest);
  }
}

export interface ThreadCreationAdmission {
  readonly requiresCreate: boolean;
  readonly settle: (accepted: boolean) => void;
}

/** Preserve first-send bootstrap unless a terminal save already owns creation; serialize both. */
export async function admitThreadCreationForSend(
  threadId: ThreadId,
  isDraft: boolean,
): Promise<ThreadCreationAdmission> {
  const pending = pendingThreadCreations.get(threadId);
  if (pending) {
    await pending;
    return { requiresCreate: false, settle: () => undefined };
  }
  if (!isDraft) {
    confirmedTerminalOwners.delete(threadId);
    return { requiresCreate: false, settle: () => undefined };
  }
  if (confirmedTerminalOwners.has(threadId))
    return { requiresCreate: false, settle: () => undefined };
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const operation = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  pendingThreadCreations.set(threadId, operation);
  void operation.catch(() => undefined);
  let settled = false;
  return {
    requiresCreate: true,
    settle: (accepted) => {
      if (settled) return;
      settled = true;
      if (pendingThreadCreations.get(threadId) === operation)
        pendingThreadCreations.delete(threadId);
      if (accepted) resolve();
      else
        reject(
          new Error(
            "The message did not confirm chat creation. Retry terminal startup after the send is reconciled; your draft is retained.",
          ),
        );
    },
  };
}
