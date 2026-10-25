import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { releaseV2PreparedSession } from "./Runtime.preparation.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";
import { runV2Cleanup } from "./Client.guard.ts";
import { stopV2OwnedDescendants } from "./Runtime.family.stop.ts";
import { cancelV2FamilyRootInputs, confirmV2FamilyRootDrain } from "./Runtime.family.inputs.ts";
import { hasV2UnconfirmedFamily } from "./Runtime.family.loss.ts";

/** Native cleanup can fail, but lease release must always run. History and journal survive. */
export async function releaseV2Session(
  session: V2RuntimeSession,
  observe?: (operation: Promise<unknown>) => void,
  shutdown?: AbortSignal,
) {
  return runV2Cleanup(session.sharedTransport, session.native.id, () =>
    releaseOwnedV2Session(session, observe, shutdown),
  );
}

async function releaseOwnedV2Session(
  session: V2RuntimeSession,
  observe?: (operation: Promise<unknown>) => void,
  shutdown?: AbortSignal,
) {
  let cancellationConfirmed = false;
  try {
    if (!session.lease.process.isRunning()) {
      if (session.lease.process.hasExited?.() === true && !hasV2UnconfirmedFamily(session)) {
        cancellationConfirmed = true;
        return;
      }
      throw new Error(
        "V2 native cleanup remains unconfirmed; server exit is not retained family shell termination.",
      );
    }
    await assertV2SharedSessionOwner(session, false);
    const cancellations = await Promise.allSettled([
      v2Request("session.interrupt", (signal) => {
        const operation = session.lease.process.client.session.interrupt(
          { sessionID: session.native.id, resume: false },
          { signal },
        );
        observe?.(operation);
        return operation;
      }),
      stopV2OwnedDescendants(session),
      session.familyControl?.fence(),
      cancelV2FamilyRootInputs(session),
    ]);
    const failed = cancellations.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (session.familyControl?.busyCount?.() || session.family?.persistenceUncertain)
      throw new Error(
        "V2 native family callbacks/persistence remain unconfirmed; guard authority retained.",
      );
    await cancelV2FamilyRootInputs(session);
    await confirmV2FamilyRootDrain(session);
    const inbox = await v2Request("session.inbox.list", (signal) =>
      session.lease.process.client.session.inbox.list({ sessionID: session.native.id }, { signal }),
    );
    if (inbox.length > 1000) throw new Error("V2 cleanup inbox bound exceeded.");
    const pending = inbox.find((item) => item.id === session.row?.nativeAdmissionId);
    if (!pending) {
      cancellationConfirmed = true;
      return;
    }
    if (
      pending.sessionID !== session.native.id ||
      pending.type !== "user" ||
      pending.payload.metadata?.bigbud_fingerprint !== session.row?.fingerprint
    )
      throw new Error("V2 cleanup admission ownership mismatch.");
    await v2Request("session.inbox.cancel", (signal) => {
      const operation = session.lease.process.client.session.inbox.cancel(
        { sessionID: session.native.id, inboxID: pending.id },
        { signal },
      );
      observe?.(operation);
      return operation;
    });
    await confirmV2FamilyRootDrain(session);
    cancellationConfirmed = true;
  } finally {
    try {
      if (cancellationConfirmed) session.session = { ...session.session, retainedFamily: false };
      if (cancellationConfirmed && session.detachSubagentGuard) {
        await session.detachSubagentGuard();
        session.detachSubagentGuard = undefined;
      }
    } finally {
      if (cancellationConfirmed || !hasV2UnconfirmedFamily(session)) {
        session.consentPermit?.release();
        await releaseV2PreparedSession(session, shutdown);
      }
    }
  }
}
