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

/**
 * The model a resolved choice picked for its held message, so a later queue flush (when another
 * blocker kept the message queued) uses it instead of the fallback stored on the queued prompt.
 */
export function resolvedHeldModelSelection(
  activities: ReadonlyArray<ModelChoiceActivity>,
  messageId: string,
): DelegationModelChoiceResolved["used"] | undefined {
  const { requested, resolved } = collectChoices(activities);
  for (const [choiceId, payload] of requested) {
    if (payload.heldMessageId !== messageId) continue;
    const resolution = resolved.get(choiceId);
    if (resolution !== undefined && resolution.cancelled !== true) return resolution.used;
  }
  return undefined;
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
