import type { OpenCodeEvent } from "@opencode/client";

/** Known native children per registered owner. Hints only; child content is never routed. */
export const V2_MAX_CHILDREN_PER_OWNER = 32;

export class V2ChildIndex {
  private readonly byOwner = new Map<string, Set<string>>();
  private readonly ownerByChild = new Map<string, string>();

  /** Learn one child of `ownerId`; a child already bound to another owner is never rebound. */
  learn(ownerId: string, childId: string): boolean {
    if (childId === ownerId) return false;
    const existing = this.ownerByChild.get(childId);
    if (existing !== undefined) return existing === ownerId;
    const children = this.byOwner.get(ownerId) ?? new Set<string>();
    if (children.size >= V2_MAX_CHILDREN_PER_OWNER) return false;
    children.add(childId);
    this.byOwner.set(ownerId, children);
    this.ownerByChild.set(childId, ownerId);
    return true;
  }

  ownerOf(childId: string): string | undefined {
    return this.ownerByChild.get(childId);
  }

  forget(ownerId: string): void {
    for (const child of this.byOwner.get(ownerId) ?? []) this.ownerByChild.delete(child);
    this.byOwner.delete(ownerId);
  }

  clear(): void {
    this.byOwner.clear();
    this.ownerByChild.clear();
  }
}

/** `session.created` naming a parent announces a native child. Forks are not children. */
export function v2CreatedChild(
  event: OpenCodeEvent,
): { readonly childId: string; readonly parentId: string } | undefined {
  if (event.type !== "session.created") return undefined;
  const { sessionID, parentID } = event.data;
  return typeof parentID === "string" && parentID !== sessionID
    ? { childId: sessionID, parentId: parentID }
    : undefined;
}

/** Text and reasoning deltas carry no lifecycle change worth an observer read. */
export function isV2ChildHintEvent(event: OpenCodeEvent): boolean {
  return !event.type.endsWith(".delta");
}
