import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runV2Cleanup } from "./Client.guard.ts";
import { releaseV2PreparedSession } from "./Runtime.preparation.ts";

/** A registered startup failure retires through ordinary exact-owner cancellation, not guard disposal alone. */
export async function retireV2FailedStart(runtime: OpencodeV2Runtime, owner: V2RuntimeSession) {
  if (runtime.sessions.get(owner.threadId) === owner) {
    // Teardown retains the owner/quarantine when cancellation cannot be proved. Do not
    // remove that record or release a still-required native guard as a startup fallback.
    const fence = owner.family?.fence();
    return runV2Cleanup(owner.sharedTransport, owner.native.id, async () => {
      const results = await Promise.allSettled([
        fence,
        owner.familyControl?.fence(),
        runtime.teardown.stop(owner.threadId, owner),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }
  owner.stopped = true;
  owner.coding?.revoke();
  owner.unregister();
  owner.unsubscribeDeath();
  owner.consentPermit?.release();
  await releaseV2PreparedSession(owner);
}
