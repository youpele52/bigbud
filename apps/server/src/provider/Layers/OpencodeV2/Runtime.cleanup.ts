import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { releaseV2PreparedSession } from "./Runtime.preparation.ts";

/** Native cleanup can fail, but lease release must always run. History and journal survive. */
export async function releaseV2Session(
  session: V2RuntimeSession,
  observe?: (operation: Promise<unknown>) => void,
) {
  try {
    if (!session.lease.process.isRunning()) {
      if (session.lease.process.hasExited?.() === true) return;
      throw new Error(
        "V2 native cleanup remains unconfirmed; transport loss is not physical exit.",
      );
    }
    await v2Request("session.interrupt", (signal) => {
      const operation = session.lease.process.client.session.interrupt(
        { sessionID: session.native.id, resume: false },
        { signal },
      );
      observe?.(operation);
      return operation;
    });
    const inbox = await v2Request("session.inbox.list", (signal) =>
      session.lease.process.client.session.inbox.list({ sessionID: session.native.id }, { signal }),
    );
    if (inbox.length > 1000) throw new Error("V2 cleanup inbox bound exceeded.");
    const pending = inbox.find((item) => item.id === session.row?.nativeAdmissionId);
    if (!pending) return;
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
  } finally {
    await releaseV2PreparedSession(session);
  }
}
