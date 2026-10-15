/**
 * Delegated-thread model choice state, derived from the tributary's activity pair. Shared by the
 * decider, dispatch safety, `get_thread_status` and the web notices so they always agree.
 *
 * @module delegatedModelChoice
 */
import {
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
  DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
  DelegationModelChoiceRequested,
  DelegationModelChoiceResolved,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { Option, Schema } from "effect";

export interface ModelChoiceActivity {
  readonly kind: string;
  readonly payload: unknown;
}

export type DelegatedModelChoiceRecord =
  | ({ readonly status: "pending" } & DelegationModelChoiceRequested)
  | ({ readonly status: "resolved"; readonly cancelled: boolean } & Omit<
      DelegationModelChoiceResolved,
      "cancelled"
    >);

const decodeRequested = Schema.decodeUnknownOption(DelegationModelChoiceRequested);
const decodeResolved = Schema.decodeUnknownOption(DelegationModelChoiceResolved);

/** Provider, model and sub-provider identify a choice; options never do (OD5). */
export function modelSelectionKey(selection: {
  readonly provider: string;
  readonly model?: string | undefined;
  readonly subProviderID?: string | undefined;
}): string {
  return JSON.stringify([
    selection.provider,
    selection.model ?? null,
    selection.subProviderID ?? null,
  ]);
}

function collectChoices(activities: ReadonlyArray<ModelChoiceActivity>) {
  const requested = new Map<string, DelegationModelChoiceRequested>();
  const resolved = new Map<string, DelegationModelChoiceResolved>();
  let latestResolved: DelegationModelChoiceResolved | null = null;
  for (const activity of activities) {
    if (activity.kind === DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND) {
      const payload = decodeRequested(activity.payload);
      if (Option.isSome(payload)) requested.set(payload.value.choiceId, payload.value);
    } else if (activity.kind === DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND) {
      const payload = decodeResolved(activity.payload);
      if (Option.isSome(payload)) {
        resolved.set(payload.value.choiceId, payload.value);
        latestResolved = payload.value;
      }
    }
  }
  return { requested, resolved, latestResolved };
}

/** The unresolved choice that holds the tributary's first turn, if any. */
export function derivePendingDelegatedModelChoice(
  activities: ReadonlyArray<ModelChoiceActivity>,
): DelegationModelChoiceRequested | null {
  const { requested, resolved } = collectChoices(activities);
  let pending: DelegationModelChoiceRequested | null = null;
  for (const [choiceId, payload] of requested) {
    if (!resolved.has(choiceId)) pending = payload;
  }
  return pending;
}

/** The pending choice, else the latest resolution (requested vs used), else `null`. */
export function deriveDelegatedModelChoiceRecord(
  activities: ReadonlyArray<ModelChoiceActivity>,
): DelegatedModelChoiceRecord | null {
  const { requested, resolved, latestResolved } = collectChoices(activities);
  for (const [choiceId, payload] of requested) {
    if (!resolved.has(choiceId)) return { status: "pending", ...payload };
  }
  if (latestResolved === null) return null;
  return { ...latestResolved, status: "resolved", cancelled: latestResolved.cancelled === true };
}
