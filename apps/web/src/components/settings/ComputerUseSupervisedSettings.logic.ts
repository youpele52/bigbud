/**
 * View model for the supervised computer-use settings areas (plan M5). Only
 * rendered under the v2 contract profile. Policy edits are awaited through a
 * port that persists the protected group and reports native acknowledgement;
 * nothing here is optimistic, and "applied" is claimed only when the native
 * side acknowledged exactly the desired revision and digest.
 */
import type {
  ComputerUseAppSelector,
  ComputerUsePolicyBody,
  ComputerUsePolicyGroup,
} from "@bigbud/contracts/core/settings.computerUsePolicy";

export type SupervisedNativeState =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "connected";
      /** Persisted Stop/pause latch; Resume is a separate human action. */
      readonly latched: boolean;
      readonly health: "ready" | "degraded" | "paused";
      readonly appliedRevision: string | null;
      readonly appliedDigest: string | null;
      /** Current owner-issued Resume challenge, when Resume is possible. */
      readonly resumeChallenge: string | null;
    };

export type SupervisedSettingsView =
  /** No settings/native transport is wired (current state before M6). */
  | { readonly kind: "not-connected" }
  /** Protected policy is corrupt/unsupported; computer use stays paused. */
  | { readonly kind: "fail-closed"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly desired: ComputerUsePolicyGroup;
      readonly native: SupervisedNativeState;
    };

/** Awaited operations; each resolves only after durable persistence. */
export interface SupervisedSettingsPort {
  readonly view: SupervisedSettingsView;
  readonly applyPolicy: (body: ComputerUsePolicyBody) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly resume: (challenge: string) => Promise<void>;
}

export type PolicyEdit = Partial<
  Pick<
    ComputerUsePolicyBody,
    "disallowedApps" | "defaultDeliveryMode" | "diagnosticMetadataEnabled"
  >
>;

export interface AppliedStateCopy {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly text: string;
}

export function describeAppliedState(view: SupervisedSettingsView): AppliedStateCopy {
  switch (view.kind) {
    case "not-connected":
      return { tone: "warning", text: "Not enforced: supervised control is not connected." };
    case "fail-closed":
      return {
        tone: "error",
        text: `Protected policy could not be used (${view.reason}); computer use stays paused.`,
      };
    case "ready":
      break;
  }
  if (view.native.kind === "unavailable") {
    return { tone: "warning", text: "Saved, not enforced: native control is unavailable." };
  }
  const { appliedRevision, appliedDigest } = view.native;
  if (appliedRevision === view.desired.revision && appliedDigest === view.desired.digest) {
    return { tone: "success", text: `Applied (revision ${view.desired.revision}).` };
  }
  return {
    tone: "info",
    text: `Waiting for native acknowledgement of revision ${view.desired.revision}.`,
  };
}

/** Restrictions may be edited only while native control can acknowledge them. */
export function canEditPolicy(view: SupervisedSettingsView, pending: boolean): boolean {
  return !pending && view.kind === "ready" && view.native.kind === "connected";
}

/** Next body for an awaited apply; the writer assigns the next revision. */
export function editPolicyBody(
  desired: ComputerUsePolicyGroup,
  edit: PolicyEdit,
): ComputerUsePolicyBody {
  const { digest: _digest, ...body } = desired;
  return { ...body, ...edit };
}

export function sameSelector(a: ComputerUseAppSelector, b: ComputerUseAppSelector): boolean {
  return a.platform === b.platform && a.kind === b.kind && a.value === b.value;
}

export function withoutSelector(
  selectors: ReadonlyArray<ComputerUseAppSelector>,
  removed: ComputerUseAppSelector,
): ReadonlyArray<ComputerUseAppSelector> {
  return selectors.filter((selector) => !sameSelector(selector, removed));
}

/**
 * Counts overlapping awaited operations so one finishing does not clear the
 * pending state of another still in flight.
 */
export function createPendingTracker(onChange: (pending: number) => void) {
  let pending = 0;
  return async (operation: () => Promise<void>): Promise<void> => {
    pending += 1;
    onChange(pending);
    try {
      await operation();
    } finally {
      pending -= 1;
      onChange(pending);
    }
  };
}
