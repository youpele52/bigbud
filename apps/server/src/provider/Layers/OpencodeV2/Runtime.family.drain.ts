import type { SessionActive } from "@opencode/client";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2OwnedChild } from "./Subagents.ownership.ts";
import { readV2OwnedChild } from "./Runtime.family.ts";
import { v2Request } from "./Client.ts";

/** Model idle is not family closure: queued inputs, interactions and native background
 * continuations retain ownership. Only Stop can close an unqualified background obligation. */
export async function readV2ChildDrain(
  owner: V2RuntimeSession,
  child: V2OwnedChild,
  active: Readonly<Record<string, SessionActive>>,
  validate: () => void,
) {
  const client = owner.lease.process.client;
  const [native, inbox, permissions, forms] = await Promise.all([
    readV2OwnedChild(owner, child),
    v2Request("owned child input drain", (signal) =>
      client.session.inbox.list({ sessionID: child.id }, { signal }),
    ),
    v2Request("owned child permission drain", (signal) =>
      client.permission.list({ sessionID: child.id }, { signal }),
    ),
    v2Request("owned child form drain", (signal) =>
      client.session.form.list({ sessionID: child.id }, { signal }),
    ),
  ]);
  validate();
  if (
    inbox.length > 1000 ||
    permissions.length > 128 ||
    forms.length > 128 ||
    inbox.some((item) => item.sessionID !== child.id)
  )
    throw new Error("V2 child drain ownership/bound rejected.");
  const revision = Math.max(native.time.updated, native.time.idle ?? 0);
  const busy = Boolean(active[child.id] || inbox.length || permissions.length || forms.length);
  const currentGeneration = (child.generation ?? 0) === owner.family!.generation;
  if (busy && child.state === "terminal") {
    const qualified = owner.familyQualification;
    qualified?.assertCurrent();
    const proven =
      qualified &&
      currentGeneration &&
      !owner.family!.isFenced &&
      revision > (child.observedRevision ?? child.nativeRevision ?? 0);
    await owner.family!.observe(child.id, proven ? "enrolled" : "uncertain", revision);
  }
  const terminal =
    !busy &&
    Boolean(native.outcome) &&
    native.time.idle !== undefined &&
    native.time.idle > (child.nativeRevision ?? 0) &&
    !owner.familyControl?.childBusyCount?.(child.id) &&
    !child.executionPending &&
    !child.continuationPending &&
    !owner.family!.children.some(
      (entry) => entry.parentId === child.id && entry.state !== "terminal",
    ) &&
    // Background model completion has no public exact synthetic-admission receipt.
    (!child.background || Boolean(child.nativeCompletion) || child.state === "terminal") &&
    (!owner.family!.isFenced || child.state === "terminal");
  if (terminal && child.state !== "terminal")
    await owner.family!.observe(child.id, "terminal", revision);
  validate();
  return { native, terminal, busy, revision, inbox, permissions, forms };
}

/** Direct settlement also rechecks terminal children: no observer/poll scheduling assumption. */
export async function refreshV2FamilyDrain(owner: V2RuntimeSession, validate: () => void) {
  await owner.familyControl?.refreshNative?.();
  validate();
  if (!owner.family?.children.length) return;
  const active = await v2Request("family settlement active", (signal) =>
    owner.lease.process.client.session.active({ signal }),
  );
  validate();
  for (const child of owner.family.children.toReversed())
    await readV2ChildDrain(owner, child, active, validate);
}
