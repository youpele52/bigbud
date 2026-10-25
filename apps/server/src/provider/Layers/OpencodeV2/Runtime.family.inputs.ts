import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { setTimeout as delay } from "node:timers/promises";

/** Explicit Stop retires queued input only in this verified root, never in another shared conversation. */
export async function cancelV2FamilyRootInputs(owner: V2RuntimeSession) {
  if (!owner.family?.children.length && !owner.familyControl) return;
  const client = owner.lease.process.client;
  const inbox = await v2Request("family root Stop inbox", (signal) =>
    client.session.inbox.list({ sessionID: owner.native.id }, { signal }),
  );
  if (inbox.length > 1000 || inbox.some((item) => item.sessionID !== owner.native.id))
    throw new Error("V2 family root input ownership/bound rejected.");
  for (const item of inbox)
    await v2Request("family root Stop inbox.cancel", (signal) =>
      client.session.inbox.cancel({ sessionID: owner.native.id, inboxID: item.id }, { signal }),
    );
}

/** Guard retirement needs actual drained observations, not an interrupt/cancel HTTP acknowledgement. */
export async function confirmV2FamilyRootDrain(owner: V2RuntimeSession, timeoutMs = 5000) {
  if (!owner.familyControl && !owner.family?.children.length) return;
  const client = owner.lease.process.client,
    deadline = AbortSignal.timeout(timeoutMs);
  for (;;) {
    const [active, inbox, permissions, forms] = await Promise.all([
      v2Request("family root active drain", (signal) => client.session.active({ signal }), {
        signal: deadline,
      }),
      v2Request(
        "family root inbox drain",
        (signal) => client.session.inbox.list({ sessionID: owner.native.id }, { signal }),
        { signal: deadline },
      ),
      v2Request(
        "family root permission drain",
        (signal) => client.permission.list({ sessionID: owner.native.id }, { signal }),
        { signal: deadline },
      ),
      v2Request(
        "family root form drain",
        (signal) => client.session.form.list({ sessionID: owner.native.id }, { signal }),
        { signal: deadline },
      ),
    ]);
    if (
      !active[owner.native.id] &&
      !inbox.length &&
      !permissions.length &&
      !forms.length &&
      !owner.familyControl?.busyCount?.()
    )
      return;
    await delay(50, undefined, { signal: deadline });
  }
}
