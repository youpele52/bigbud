import { setTimeout as delay } from "node:timers/promises";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runV2Cleanup } from "./Client.guard.ts";
import { v2Request } from "./Client.ts";
import { readV2OwnedChild } from "./Runtime.family.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";

/** Resume a durable Stop, never a prompt. A missing observation leaves the family owned and fenced. */
export async function recoverV2FamilyStop(owner: V2RuntimeSession) {
  if (!owner.family?.isFenced || !owner.family.live) return;
  await runV2Cleanup(owner.sharedTransport, owner.native.id, async () => {
    await assertV2SharedSessionOwner(owner, false);
    await stopV2OwnedDescendants(owner);
  });
  if (owner.executionBlocked?.startsWith("V2 descendant")) owner.executionBlocked = undefined;
}

/** Stop is not complete on interrupt acknowledgement. Keep durable uncertain ownership until observed terminal. */
export async function stopV2OwnedDescendants(owner: V2RuntimeSession, timeoutMs = 5000) {
  const family = owner.family;
  if (!family) return;
  let unconfirmed = family.persistenceUncertain;
  await family.fence().catch(() => {
    unconfirmed = true;
  });
  if (!family.children.length) {
    await owner.familyControl?.confirmCancellation?.();
    unconfirmed ||= family.pendingSpawnCount > 0;
    if (unconfirmed) {
      owner.executionBlocked =
        "V2 descendant Stop persistence remains unconfirmed; root cancellation was still attempted. No rearming.";
      throw new Error(owner.executionBlocked);
    }
    return;
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const client = owner.lease.process.client;
  // Every verified target gets an attempt even if one sibling loses its acknowledgement.
  // The synchronous fence already blocks nested/racing executor admission.
  await Promise.all(
    family.children.map(async (child) => {
      try {
        await runV2Cleanup(
          owner.sharedTransport,
          child.id,
          async () => {
            await readV2OwnedChild(owner, child);
            // Interrupt even a previously terminal child: a completion wake can have queued new work.
            await v2Request(
              "owned child interrupt",
              (signal) =>
                client.session.interrupt({ sessionID: child.id, resume: false }, { signal }),
              { signal: deadline },
            );
            const inbox = await v2Request(
              "owned child inbox",
              (signal) => client.session.inbox.list({ sessionID: child.id }, { signal }),
              { signal: deadline },
            );
            if (inbox.length > 1000 || inbox.some((item) => item.sessionID !== child.id))
              throw new Error("V2 descendant inbox ownership/bound rejected.");
            for (const item of inbox)
              await v2Request(
                "owned child inbox.cancel",
                (signal) =>
                  client.session.inbox.cancel(
                    { sessionID: child.id, inboxID: item.id },
                    { signal },
                  ),
                { signal: deadline },
              );
            const forms = await v2Request(
              "owned child forms",
              (signal) => client.session.form.list({ sessionID: child.id }, { signal }),
              { signal: deadline },
            );
            if (forms.length > 128 || forms.some((form) => form.sessionID !== child.id))
              throw new Error("V2 descendant form ownership/bound rejected.");
            for (const form of forms)
              await v2Request(
                "owned child form.cancel",
                (signal) =>
                  client.session.form.cancel({ sessionID: child.id, formID: form.id }, { signal }),
                { signal: deadline },
              );
            for (;;) {
              const native = await readV2OwnedChild(owner, child);
              const [active, inbox, permissions, forms] = await Promise.all([
                v2Request("owned child active", (signal) => client.session.active({ signal }), {
                  signal: deadline,
                }),
                v2Request(
                  "owned child inbox",
                  (signal) => client.session.inbox.list({ sessionID: child.id }, { signal }),
                  { signal: deadline },
                ),
                v2Request(
                  "owned child permissions",
                  (signal) => client.permission.list({ sessionID: child.id }, { signal }),
                  { signal: deadline },
                ),
                v2Request(
                  "owned child forms",
                  (signal) => client.session.form.list({ sessionID: child.id }, { signal }),
                  { signal: deadline },
                ),
              ]);
              if (
                !active[child.id] &&
                !inbox.length &&
                !permissions.length &&
                !forms.length &&
                native.time.idle !== undefined &&
                native.outcome
              ) {
                await owner.familyControl?.confirmCancellation?.();
                const current = family.child(child.id)!;
                if (current.executionPending || current.continuationPending)
                  throw new Error(
                    "V2 native executor/continuation cancellation receipt remains unconfirmed.",
                  );
                await family.observe(child.id, "terminal");
                break;
              }
              await delay(50, undefined, { signal: deadline });
            }
          },
          deadline,
        );
      } catch {
        await family.observe(child.id, "uncertain").catch(() => {});
        unconfirmed = true;
      }
    }),
  );
  if (unconfirmed || family.pendingSpawnCount > 0) {
    owner.executionBlocked =
      "V2 descendant Stop remains unconfirmed; ownership retained. Retry Stop after reconnect; no automatic replay.";
    throw new Error(owner.executionBlocked);
  }
}
