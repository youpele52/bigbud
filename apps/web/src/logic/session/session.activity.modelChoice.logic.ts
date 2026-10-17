/**
 * Delegated-thread model choice state for the web, next to the approval derivations. The
 * derivation itself is shared with the server (`@bigbud/shared/delegatedModelChoice`, D-1).
 *
 * @module session.activity.modelChoice.logic
 */
import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import { DelegationModelChoiceLinkedSummary } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import {
  deriveDelegatedModelChoiceRecord,
  type DelegatedModelChoiceRecord,
} from "@bigbud/shared/delegatedModelChoice";
import { Option, Schema } from "effect";

// Store updates replace the activities array, so one derivation per array is always current.
const derivations = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  DelegatedModelChoiceRecord | null
>();

/** The pending choice, else the latest resolution (requested vs used), else `null`. */
export function deriveThreadModelChoice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DelegatedModelChoiceRecord | null {
  const cached = derivations.get(activities);
  if (cached !== undefined) return cached;
  const record = deriveDelegatedModelChoiceRecord(activities);
  derivations.set(activities, record);
  return record;
}

const decodeLinkedSummary = Schema.decodeUnknownOption(DelegationModelChoiceLinkedSummary);

/** Reads the optional `modelChoice` summary on a `delegation.child-linked` payload. */
export function readLinkedModelChoiceSummary(
  payload: Record<string, unknown>,
): DelegationModelChoiceLinkedSummary | null {
  if (payload.modelChoice === undefined) return null;
  return Option.getOrNull(decodeLinkedSummary(payload.modelChoice));
}
