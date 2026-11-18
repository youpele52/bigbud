import type { MobileGatewayDesiredSelection } from "./mobileGatewayActivation.selection.schema.ts";

interface SelectionState {
  readonly consent: { readonly revision: number; readonly enabled: boolean };
  readonly gatewayLifecycle?:
    | { readonly attempts: readonly { readonly phase: string }[] }
    | undefined;
  readonly stages: readonly { readonly id: string; readonly phase: string }[];
  readonly desired?: MobileGatewayDesiredSelection | undefined;
  readonly desiredHistory?: readonly MobileGatewayDesiredSelection[] | undefined;
  readonly retired?: { readonly selections: number } | undefined;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/**
 * Exact immutable prefix; generic CAS writers cannot erase retired request replay fences. Only
 * stage retirement may drop the oldest rows, and only together with the stages they name.
 */
export function assertMobileGatewaySelectionTransition(
  before: SelectionState,
  next: SelectionState,
): void {
  // Stage retirement drops a settled prefix whose stages left in the same CAS; nothing else may.
  const dropped = (next.retired?.selections ?? 0) - (before.retired?.selections ?? 0);
  const prior = before.desiredHistory ?? [];
  if (
    dropped < 0 ||
    dropped > prior.length ||
    prior.slice(0, dropped).some((row) => next.stages.some((stage) => stage.id === row.stageId))
  )
    throw Error("Only selections of retired stages may leave the history, oldest first.");
  const history = prior.slice(dropped),
    nextHistory = next.desiredHistory ?? [];
  const changed = !same(before.desired, next.desired);
  if (changed && next.desired) {
    if (
      !next.consent.enabled ||
      next.desired.consentRevision !== next.consent.revision ||
      next.stages.find((s) => s.id === next.desired!.stageId)?.phase !== "files-published" ||
      before.gatewayLifecycle?.attempts.some((a) => a.phase !== "exit-confirmed") ||
      next.gatewayLifecycle?.attempts.some((a) => a.phase !== "exit-confirmed")
    )
      throw Error(
        "Desired selection requires current consent, published files and settled children.",
      );
  }
  if (!before.desired) {
    if (nextHistory.length || (next.desired && next.desired.revision !== 1))
      throw Error("First desired selection must begin with revision one and no history.");
    return;
  }
  if (!next.desired) throw Error("Mobile desired selection cannot be discarded.");
  if (same(before.desired, next.desired)) {
    if (!same(history, nextHistory)) throw Error("Retired activation requests cannot be changed.");
    return;
  }
  if (
    next.desired.revision !== before.desired.revision + 1 ||
    next.desired.requestId === before.desired.requestId ||
    !same(nextHistory, [...history, before.desired])
  )
    throw Error("Desired replacement must append the exact prior selection and advance revision.");
}
