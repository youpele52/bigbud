import { MOBILE_GATEWAY_POLICY } from "@bigbud/shared/mobileGatewaySupervisor.config";
import * as Schema from "effect/Schema";
import {
  MobileNativeGatewayOwnership,
  MobileNativeGatewayCompletion,
} from "./mobileGatewayLifecycle.native.schema.ts";
import { validateMobileNativeGatewayAttempt } from "./mobileGatewayLifecycle.native.invariants.ts";

const Counter = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
export const MobileGatewayController = Schema.Struct({
  id: Token,
  pid: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
  startedAt: Token,
});
export const MobileGatewayControllerHost = Schema.Struct({
  hostname: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/)),
  machineId: Schema.NullOr(Token),
});
export type MobileGatewayControllerHost = typeof MobileGatewayControllerHost.Type;
export const MobileGatewayBinding = Schema.Struct({
  buildId: Token,
  generation: Token,
  epoch: Token,
  connectionId: Token,
});
export type MobileGatewayBinding = typeof MobileGatewayBinding.Type;
export const MobileGatewayConfiguration = Schema.Struct({
  externalOrigin: Schema.String.check(Schema.isMaxLength(2048)),
  port: Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
});
export type MobileGatewayConfiguration = typeof MobileGatewayConfiguration.Type;
export const MobileGatewayChild = Schema.Struct({
  pid: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
  startedAt: Token,
});
export const MobileGatewayCompletionEvidence = Schema.Union([
  MobileNativeGatewayCompletion,
  Schema.Struct({
    kind: Schema.Literal("original-handle-exit"),
    pid: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({ kind: Schema.Literal("original-handle-spawn-failed") }),
  Schema.Struct({ kind: Schema.Literal("original-permit-not-launched") }),
  Schema.Struct({
    kind: Schema.Literal("successor-recorded-child-dead"),
    reconciledBy: MobileGatewayController,
    reconcilerHost: MobileGatewayControllerHost,
  }),
]);
export type MobileGatewayCompletionEvidence = typeof MobileGatewayCompletionEvidence.Type;
export const MobileGatewayAttempt = Schema.Struct({
  nonce: Token,
  stageId: Token,
  releaseId: Schema.String.check(Schema.isPattern(/^mobile-release:[a-f0-9]{64}$/)),
  consentRevision: Counter.check(Schema.isGreaterThanOrEqualTo(1)),
  controller: MobileGatewayController,
  controllerHost: Schema.optional(MobileGatewayControllerHost),
  binding: MobileGatewayBinding,
  nativeOwnership: Schema.optional(MobileNativeGatewayOwnership),
  configuration: MobileGatewayConfiguration,
  reservedAtUnixMs: Counter,
  attemptedAtUnixMs: Schema.optional(Counter),
  kind: Schema.Literals(["initial", "crash-restart"]),
  phase: Schema.Literals(["reserved", "attempted", "child-owned", "exit-confirmed"]),
  child: Schema.optional(MobileGatewayChild),
  exitedAtUnixMs: Schema.optional(Counter),
  completionEvidence: Schema.optional(MobileGatewayCompletionEvidence),
});
export type MobileGatewayAttempt = typeof MobileGatewayAttempt.Type;
export const MobileGatewayLifecycle = Schema.Struct({
  lastObservedUnixMs: Counter,
  repairRequired: Schema.Boolean,
  attempts: Schema.Array(MobileGatewayAttempt),
});
export type MobileGatewayLifecycle = typeof MobileGatewayLifecycle.Type;
export const MAX_MOBILE_GATEWAY_ATTEMPTS = 32;

export function validateMobileGatewayConfiguration(
  configuration: MobileGatewayConfiguration,
): void {
  const url = new URL(configuration.externalOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== configuration.externalOrigin ||
    url.username ||
    url.password ||
    !Number.isInteger(configuration.port) ||
    configuration.port < 1 ||
    configuration.port > 65535
  )
    throw new Error(
      "Gateway configuration requires canonical HTTPS origin and fixed loopback port.",
    );
}
export function validateMobileGatewayLifecycle(lifecycle: MobileGatewayLifecycle): void {
  if (lifecycle.attempts.length > MAX_MOBILE_GATEWAY_ATTEMPTS)
    throw new Error("Gateway lifetime attempt ledger is full; owner repair required.");
  const nonces = new Set<string>();
  let priorTime = 0,
    unresolved = 0;
  for (const [index, attempt] of lifecycle.attempts.entries()) {
    validateMobileGatewayConfiguration(attempt.configuration);
    validateMobileNativeGatewayAttempt(attempt);
    if (
      attempt.kind !== (index === 0 ? "initial" : "crash-restart") ||
      lifecycle.attempts
        .slice(0, index)
        .filter(
          (a) =>
            a.kind === "crash-restart" &&
            (attempt.attemptedAtUnixMs ?? attempt.reservedAtUnixMs) -
              (a.attemptedAtUnixMs ?? a.reservedAtUnixMs) <
              MOBILE_GATEWAY_POLICY.crashWindowMs,
        ).length >= MOBILE_GATEWAY_POLICY.maxCrashRestarts ||
      nonces.has(attempt.nonce) ||
      attempt.reservedAtUnixMs < priorTime ||
      attempt.reservedAtUnixMs > lifecycle.lastObservedUnixMs ||
      (attempt.phase === "reserved" && attempt.attemptedAtUnixMs !== undefined) ||
      (attempt.phase !== "reserved" &&
        attempt.attemptedAtUnixMs === undefined &&
        !(
          attempt.phase === "exit-confirmed" &&
          (attempt.completionEvidence?.kind === "original-permit-not-launched" ||
            attempt.completionEvidence?.kind === "native-exit" ||
            attempt.completionEvidence?.kind === "native-cancel" ||
            attempt.completionEvidence?.kind === "native-never-invoked")
        )) ||
      (attempt.attemptedAtUnixMs !== undefined &&
        (attempt.attemptedAtUnixMs < attempt.reservedAtUnixMs ||
          attempt.attemptedAtUnixMs > lifecycle.lastObservedUnixMs)) ||
      (attempt.phase === "child-owned" && !attempt.child) ||
      (attempt.child !== undefined && !["child-owned", "exit-confirmed"].includes(attempt.phase)) ||
      (attempt.completionEvidence !== undefined && attempt.phase !== "exit-confirmed") ||
      (attempt.phase === "exit-confirmed" && !attempt.child && !attempt.completionEvidence) ||
      (attempt.completionEvidence?.kind === "successor-recorded-child-dead" &&
        (!attempt.child || !attempt.controllerHost)) ||
      (attempt.completionEvidence?.kind === "original-permit-not-launched" &&
        attempt.child !== undefined) ||
      (attempt.completionEvidence?.kind === "original-handle-spawn-failed" &&
        attempt.child !== undefined) ||
      (attempt.completionEvidence?.kind === "original-handle-exit" &&
        attempt.child !== undefined &&
        attempt.completionEvidence.pid !== attempt.child.pid) ||
      (attempt.exitedAtUnixMs !== undefined) !== (attempt.phase === "exit-confirmed") ||
      (attempt.exitedAtUnixMs !== undefined &&
        (attempt.exitedAtUnixMs < (attempt.attemptedAtUnixMs ?? attempt.reservedAtUnixMs) ||
          attempt.exitedAtUnixMs > lifecycle.lastObservedUnixMs))
    )
      throw new Error("Invalid gateway attempt journal.");
    nonces.add(attempt.nonce);
    priorTime = attempt.exitedAtUnixMs ?? attempt.attemptedAtUnixMs ?? attempt.reservedAtUnixMs;
    if (attempt.phase !== "exit-confirmed") unresolved += 1;
  }
  if (unresolved > 1) throw new Error("Gateway lifecycle cannot overlap uncertain children.");
}
