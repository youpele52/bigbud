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
export function assertMobileGatewayLifecycleTransition(
  before: RemoteAgentRegistry,
  next: RemoteAgentRegistry,
): void {
  const prior = before.schemaVersion === 3 ? before.mobile.gatewayLifecycle : undefined;
  const current = next.schemaVersion === 3 ? next.mobile.gatewayLifecycle : undefined;
  if (
    prior &&
    (!current ||
      current.lastObservedUnixMs < prior.lastObservedUnixMs ||
      (prior.repairRequired && !current.repairRequired) ||
      current.attempts.length < prior.attempts.length)
  )
    throw new Error("Gateway durable budget/replay history cannot be reset or rolled back.");
  for (const [index, attempt] of (prior?.attempts ?? []).entries()) {
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
      (attempt.phase === observed.phase && JSON.stringify(attempt) !== JSON.stringify(observed))
    )
      throw new Error("Gateway attempt identity/child/phase fence changed.");
  }
  if (current) {
    if (current.attempts.length > (prior?.attempts.length ?? 0) + 1)
      throw new Error("One CAS admits at most one gateway attempt.");
    const added = current.attempts.slice(prior?.attempts.length ?? 0);
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
