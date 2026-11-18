import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { mobileGatewayBuildPin } from "./mobileGatewayLifecycle.transitions.ts";
import type { MobileGatewayAttempt } from "./mobileGatewayLifecycle.schema.ts";

const rank = { reserved: 0, attempted: 1, "child-owned": 2, "exit-confirmed": 3 } as const;
const immutable = (a: MobileGatewayAttempt) =>
  JSON.stringify([
    a.nonce,
    a.stageId,
    a.releaseId,
    a.consentRevision,
    a.controller,
    a.controllerHost,
    a.binding,
    a.nativeOwnership,
    a.configuration,
    a.reservedAtUnixMs,
    a.kind,
  ]);
/** Everything except the adopting successor, which only an attempted native row may change. */
const withoutAdoption = ({ currentController: _adopted, ...rest }: MobileGatewayAttempt) =>
  JSON.stringify(rest);
const adoptionChanged = (before: MobileGatewayAttempt, after: MobileGatewayAttempt) =>
  JSON.stringify(before.currentController) !== JSON.stringify(after.currentController);
const tally = (state: RemoteAgentRegistry) =>
  state.schemaVersion === 3 ? (state.mobile.retired?.attempts ?? 0) : 0;
/**
 * Stage retirement may drop a settled, unpinned prefix whose stages leave in the same CAS (the
 * tally advances by exactly the dropped count); every other row keeps its full fence.
 */
function retainedAttempts(
  before: RemoteAgentRegistry,
  next: RemoteAgentRegistry,
  attempts: readonly MobileGatewayAttempt[],
): readonly MobileGatewayAttempt[] {
  const dropped = tally(next) - tally(before);
  if (
    dropped < 0 ||
    dropped > attempts.length ||
    attempts
      .slice(0, dropped)
      .some(
        (a) =>
          a.phase !== "exit-confirmed" ||
          next.pins.some((p) => p.owner === mobileGatewayBuildPin(a.nonce)) ||
          (next.schemaVersion === 3 && next.mobile.stages.some((s) => s.id === a.stageId)),
      )
  )
    throw new Error("Only settled attempts of retired stages may leave the journal, oldest first.");
  return attempts.slice(dropped);
}
export function assertMobileGatewayLifecycleTransition(
  before: RemoteAgentRegistry,
  next: RemoteAgentRegistry,
): void {
  const prior = before.schemaVersion === 3 ? before.mobile.gatewayLifecycle : undefined;
  const current = next.schemaVersion === 3 ? next.mobile.gatewayLifecycle : undefined;
  const kept = retainedAttempts(before, next, prior?.attempts ?? []);
  if (
    prior &&
    (!current ||
      current.lastObservedUnixMs < prior.lastObservedUnixMs ||
      (prior.repairRequired && !current.repairRequired) ||
      current.attempts.length < kept.length)
  )
    throw new Error("Gateway durable budget/replay history cannot be reset or rolled back.");
  for (const [index, attempt] of kept.entries()) {
    const observed = current?.attempts[index];
    if (
      !observed ||
      immutable(attempt) !== immutable(observed) ||
      rank[observed.phase] < rank[attempt.phase] ||
      (rank[observed.phase] > rank[attempt.phase] + 1 &&
        !(
          attempt.phase === "reserved" &&
          observed.phase === "exit-confirmed" &&
          (observed.completionEvidence?.kind === "original-permit-not-launched" ||
            observed.completionEvidence?.kind === "native-exit" ||
            observed.completionEvidence?.kind === "native-cancel" ||
            observed.completionEvidence?.kind === "native-never-invoked")
        ) &&
        !(
          attempt.phase === "attempted" &&
          observed.phase === "exit-confirmed" &&
          (observed.child || observed.completionEvidence)
        )) ||
      (attempt.attemptedAtUnixMs !== undefined &&
        attempt.attemptedAtUnixMs !== observed.attemptedAtUnixMs) ||
      (attempt.child && JSON.stringify(attempt.child) !== JSON.stringify(observed.child)) ||
      (attempt.phase === "exit-confirmed" &&
        JSON.stringify(attempt) !== JSON.stringify(observed)) ||
      (attempt.phase === observed.phase &&
        withoutAdoption(attempt) !== withoutAdoption(observed)) ||
      (adoptionChanged(attempt, observed) &&
        (attempt.phase !== "attempted" ||
          observed.phase !== "attempted" ||
          !observed.nativeOwnership ||
          !observed.currentController))
    )
      throw new Error("Gateway attempt identity/child/phase fence changed.");
  }
  if (current) {
    if (current.attempts.length > kept.length + 1)
      throw new Error("One CAS admits at most one gateway attempt.");
    const added = current.attempts.slice(kept.length);
    if (added.some((a) => a.phase !== "reserved"))
      throw new Error("Gateway attempt must begin reserved.");
    for (const attempt of current.attempts) {
      const owner = mobileGatewayBuildPin(attempt.nonce);
      const pin = next.pins.find((p) => p.owner === owner);
      if (attempt.phase !== "exit-confirmed" && pin?.buildId !== attempt.binding.buildId)
        throw new Error("Unresolved gateway requires its exact existing P4 build pin.");
      if (attempt.phase === "exit-confirmed" && pin)
        throw new Error("Confirmed gateway exit must retire only its own base pin.");
    }
  }
}
