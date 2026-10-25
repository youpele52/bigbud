import { readV2LinuxRecoveryHost } from "./RebootRecovery.host.linux.ts";
import { readV2DarwinRecoveryHost } from "./RebootRecovery.host.darwin.ts";
import { readV2WindowsRecoveryHost, v2WindowsBootSequence } from "./RebootRecovery.host.windows.ts";

export interface V2RecoveryHost {
  readonly host: string;
  readonly bootSession: string;
  readonly bootSeconds: number;
  readonly bootMicroseconds: number;
}
let observation: Promise<V2RecoveryHost> | undefined;

/** OS identity, never environment, uptime, service generation, or a caller-supplied reboot flag. */
export function readV2RecoveryHost(): Promise<V2RecoveryHost> {
  return (observation ??= observe().catch((error) => {
    observation = undefined;
    throw error;
  }));
}

async function observe(): Promise<V2RecoveryHost> {
  if (process.platform === "linux") return readV2LinuxRecoveryHost();
  if (process.platform === "darwin") return readV2DarwinRecoveryHost();
  if (process.platform === "win32") return readV2WindowsRecoveryHost();
  throw new Error(
    "V2 reboot recovery requires authoritative native host and boot-session evidence on this platform.",
  );
}

/** Require a same-host kernel generation transition; POSIX also requires forward boot time. */
export function assertV2RebootBoundary(before: V2RecoveryHost, after: V2RecoveryHost) {
  if (before.host !== after.host) throw new Error("V2 reboot recovery host changed.");
  const prior = v2WindowsBootSequence(before.bootSession),
    current = v2WindowsBootSequence(after.bootSession);
  if (
    before.bootSession === after.bootSession ||
    (prior !== undefined || current !== undefined
      ? prior === undefined || current === undefined || current <= prior
      : after.bootSeconds <= before.bootSeconds)
  )
    throw new Error(
      "V2 reboot recovery requires the prepared host to restart; same boot cannot retire owners.",
    );
}

/** Windows generation is a kernel sequence: NTP changes must neither retire owners nor invalidate the same boot. */
export function assertV2RecoveryContinuation(sealed: V2RecoveryHost, current: V2RecoveryHost) {
  if (sealed.host !== current.host) throw new Error("V2 reboot recovery seal/host changed.");
  const before = v2WindowsBootSequence(sealed.bootSession),
    after = v2WindowsBootSequence(current.bootSession);
  if (before !== undefined || after !== undefined) {
    if (before === undefined || after === undefined || after < before)
      throw new Error("V2 reboot recovery kernel boot sequence regressed.");
  } else if (
    current.bootSeconds < sealed.bootSeconds ||
    (current.bootSeconds === sealed.bootSeconds && current.bootSession !== sealed.bootSession)
  )
    throw new Error("V2 reboot recovery seal/host changed.");
}
