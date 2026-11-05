import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";

/** Retire borrowed connection resources only; durable owners and native work remain retained. */
export async function detachV2BorrowedRuntime(runtime: OpencodeV2Runtime): Promise<void> {
  const connection = runtime.options.config.sharedService;
  if (!connection) throw new Error("V2 runtime detachment requires shared native topology.");
  for (const owner of runtime.sessions.values()) {
    runtime.options.threadBridge?.suspend?.(owner);
    suspendV2BorrowedOwner(owner);
  }
  await runtime.options.manager.retireBorrowedGeneration(connection);
}

/** Fence local deliveries without interpreting borrowed transport loss as native cancellation. */
export function suspendV2BorrowedOwner(owner: V2RuntimeSession): void {
  if (owner.lease.process.ownership !== "borrowed")
    throw new Error("V2 transport suspension requires a borrowed owner.");
  if (owner.transportDetached || owner.stopped) return;
  owner.transportDetached = true;
  owner.transportRevision = (owner.transportRevision ?? 0) + 1;
  owner.transportRecovering = true;
  owner.dirtyGeneration++;
  owner.threadToolsReady = false;
  owner.executionBlocked =
    "V2 native generation reconnecting; retained history and execution remain unconfirmed. No automatic resend.";
  owner.session = { ...owner.session, status: "error", lastError: owner.executionBlocked };
  owner.unregister();
  owner.unsubscribeDeath();
  // Do not revoke coding/family controls, settle reservations, or run resource cleanup here:
  // their teardown paths can cancel work still running in the native shared service.
}
