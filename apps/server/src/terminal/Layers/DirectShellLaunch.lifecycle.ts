import posix from "node:path/posix";
import * as Schema from "effect/Schema";
import { hasRemoteAgentPathControls } from "../../remote-agent/remoteAgentRuntime";
import type { DirectShellLaunchOwner } from "./DirectShellLaunch.owner";

const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/));
const AbsolutePath = Schema.String.check(Schema.isMaxLength(4096)).check(
  Schema.makeFilter(
    (path) =>
      path.length > 1 &&
      path.startsWith("/") &&
      posix.normalize(path) === path &&
      !hasRemoteAgentPathControls(path),
  ),
);

/** Reserved for a trusted, packaged host helper. Never learned from PTY output or a PID.
 * The resolver must validate executable bytes, host/account, private state and protocol
 * before reservation. Existing owners cannot be retroactively enrolled in this protocol.
 */
export const DirectShellLifecycleBinding = Schema.Struct({
  version: Schema.Literal(1),
  executable: AbsolutePath,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  statePath: AbsolutePath,
  epoch: Token,
});
export type DirectShellLifecycleBinding = typeof DirectShellLifecycleBinding.Type;

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  ownerKey: Schema.String,
  reservationId: Token,
  controllerId: Schema.String,
  digest: Schema.String,
  epoch: Token,
  state: Schema.Literal("terminated"),
  childReaped: Schema.Literal(true),
  ptyReleased: Schema.Literal(true),
  cleanupComplete: Schema.Literal(true),
  admissionClosed: Schema.Literal(true),
});

/** Application-owned control only, not an RPC input, browser callback, or TTY parser.
 * Implementations must use the stored execution host/account and helper binding,
 * revalidate executable/private-state identity, and use a bounded authenticated non-TTY
 * channel. They must never prepare/restart a helper, adopt an unknown process, or create
 * a terminal. No production implementation is enabled until host qualification passes.
 *
 * A helper may report admissionClosed only after durably fencing this reservation
 * against every future/delayed create. Missing records are NOT termination evidence.
 * Its epoch and closed admissions must survive controller loss; uncertain helper state
 * must fail closed, including capacity exhaustion (no eviction of closed admissions).
 */
export interface DirectShellLifecycleControl {
  readonly closeAndVerify: (owner: DirectShellLaunchOwner) => Promise<string>;
}

export function directShellLifecycleDigestFields(binding: DirectShellLifecycleBinding) {
  const value = Schema.decodeUnknownSync(DirectShellLifecycleBinding)(binding);
  return [value.version, value.executable, value.sha256, value.statePath, value.epoch];
}

/** A matched frame is meaningful ONLY on the authenticated control above. Not a signature
 * or exec-identity proof. Bound before JSON parsing; unknown/additional fields are refused.
 */
export function verifyDirectShellTermination(owner: DirectShellLaunchOwner, frame: string): void {
  const binding = owner.intent.lifecycle;
  if (!binding || owner.state === "prepared")
    throw new Error("Direct shell owner has no dispatched trusted lifecycle binding.");
  if (Buffer.byteLength(frame) > 4096)
    throw new Error("Direct shell termination receipt exceeds its bound.");
  const receipt = Schema.decodeUnknownSync(Receipt)(JSON.parse(frame), {
    onExcessProperty: "error",
  });
  if (
    receipt.ownerKey !== owner.ownerKey ||
    receipt.reservationId !== owner.reservationId ||
    receipt.controllerId !== owner.controllerId ||
    receipt.digest !== owner.digest ||
    receipt.epoch !== binding.epoch
  )
    throw new Error("Direct shell termination receipt does not match its reserved owner.");
}
