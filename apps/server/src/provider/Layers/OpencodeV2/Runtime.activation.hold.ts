import { AsyncLocalStorage } from "node:async_hooks";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2FamilyInteractionCount } from "./Runtime.family.interactions.state.ts";

/** Why a retained execution reservation was not settled. Observability only: never authority. */
export type V2SettlementHoldReason =
  | "mutations-busy"
  | "admission-in-flight"
  | "coding-busy"
  | "publication-unconfirmed"
  | "final-events"
  | "final-publication-pending"
  | "pending-interactions"
  | "row-not-terminal"
  | "unresolved-journal"
  | "binding"
  | "native-active"
  | "family-persistence"
  | "family-live"
  | "family-callbacks"
  | "family-interactions"
  /** The reservation/token changed while the exact-session drain read was in flight. */
  | "callbacks";

/** Same predicate as the settlement `busy()` fence, reporting the first holding condition. */
export function v2SettlementBusyReason(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
): V2SettlementHoldReason | undefined {
  if (runtime.mutations.busyCount()) return "mutations-busy";
  if (owner.admissionInFlight) return "admission-in-flight";
  if (owner.coding?.busyCount?.()) return "coding-busy";
  if (owner.publicationUnconfirmed) return "publication-unconfirmed";
  if (owner.finalEvents?.length) return "final-events";
  if (owner.finalPublication?.state === "pending") return "final-publication-pending";
  if (owner.pendingInteractions?.size) return "pending-interactions";
  if (owner.family?.persistenceUncertain) return "family-persistence";
  if (owner.familyControl?.busyCount?.()) return "family-callbacks";
  if (v2FamilyInteractionCount(owner)) return "family-interactions";
  if (owner.family?.live) return "family-live";
  return undefined;
}

/** Redacted counts for diagnostics: sizes only, never prompts, payloads or credentials. */
export function v2SettlementHoldCounts(runtime: OpencodeV2Runtime, owner: V2RuntimeSession) {
  return {
    mutations: runtime.mutations.busyCount(),
    coding: owner.coding?.busyCount?.() ?? 0,
    finalEvents: owner.finalEvents?.length ?? 0,
    pendingInteractions: owner.pendingInteractions?.size ?? 0,
  };
}

const settlement = new AsyncLocalStorage<true>();
/** Marks settlement reads so request-authority rejections inside them are diagnosable. */
export const runInV2Settlement = <T>(run: () => Promise<T>) => settlement.run(true, run);
export const inV2Settlement = () => settlement.getStore() === true;
