import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/**
 * Leaf registry of retained child reply obligations. Kept free of runtime package imports so
 * activation exclusion (and the guard/lock modules that depend on it) stays loadable alone.
 */
export interface V2FamilyInteractionTarget {
  readonly opened: ProviderRuntimeEvent;
  readonly view: V2RuntimeSession;
  readonly rawId: string;
  readonly kind: "permission" | "form";
  readonly fingerprint: string;
  readonly taskId: string;
  readonly generation: number;
}
interface V2FamilyInteractionState {
  readonly views: Map<string, V2RuntimeSession>;
  readonly targets: Map<string, V2FamilyInteractionTarget>;
}
const states = new WeakMap<V2RuntimeSession, V2FamilyInteractionState>();

/** Retained child reply obligations also hold physical activation exclusion. */
export function v2FamilyInteractionCount(owner: V2RuntimeSession) {
  return states.get(owner)?.targets.size ?? 0;
}

export function v2FamilyInteractionState(owner: V2RuntimeSession) {
  let value = states.get(owner);
  if (!value) {
    value = { views: new Map(), targets: new Map() };
    states.set(owner, value);
  }
  return value;
}
