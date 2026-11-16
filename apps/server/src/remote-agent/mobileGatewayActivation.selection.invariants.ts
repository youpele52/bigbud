import type { MobileGatewayDesiredSelection } from "./mobileGatewayActivation.selection.schema.ts";

interface SelectionState {
  readonly consent: { readonly revision: number; readonly enabled: boolean };
  readonly gatewayLifecycle?:
    | { readonly attempts: readonly { readonly phase: string }[] }
    | undefined;
  readonly stages: readonly { readonly id: string; readonly phase: string }[];
  readonly desired?: MobileGatewayDesiredSelection | undefined;
  readonly desiredHistory?: readonly MobileGatewayDesiredSelection[] | undefined;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Exact immutable prefix; generic CAS writers cannot erase retired request replay fences. */
export function assertMobileGatewaySelectionTransition(
  before: SelectionState,
  next: SelectionState,
): void {
  const history = before.desiredHistory ?? [],
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
