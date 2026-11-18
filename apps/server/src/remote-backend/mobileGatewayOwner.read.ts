import {
  decodeRemoteMobileAdmissionStamp,
  mobileAdmissionStampEqual,
  type RemoteMobileAdmissionStamp,
} from "../mobile/Services/MobileRemoteControlAdmission.ts";
import type { MobileGatewayOwnerState } from "./mobileGatewayOwner.state.ts";

/** A liveness read that observed a changed admission identity (for example a native generation or
 * durable consent revision) rather than a failed or uncertain read. It retires as "revoked". */
export class MobileGatewayAdmissionRevoked extends Error {
  override readonly name = "MobileGatewayAdmissionRevoked";
}

export interface ActiveMobileGatewayAdmission {
  readonly lease: ReturnType<MobileGatewayOwnerState["begin"]>;
  readonly stamp: RemoteMobileAdmissionStamp;
  readonly read: (signal: AbortSignal) => Promise<unknown>;
}

/** Each caller may cancel its read; only actual admission failure retires the shared lifetime. */
export async function readCurrentMobileGatewayAdmission(
  current: () => ActiveMobileGatewayAdmission | undefined,
  signal: AbortSignal,
): Promise<RemoteMobileAdmissionStamp | null> {
  const selected = current();
  if (signal.aborted || !selected?.lease.isAdmitted()) return null;
  try {
    const stamp = decodeRemoteMobileAdmissionStamp(await selected.read(signal));
    if (signal.aborted) return null;
    if (!stamp || !mobileAdmissionStampEqual(selected.stamp, stamp)) {
      selected.lease.invalidate("revoked");
      return null;
    }
    return current() === selected && selected.lease.isAdmitted() ? stamp : null;
  } catch (cause) {
    if (!signal.aborted)
      selected.lease.invalidate(
        cause instanceof MobileGatewayAdmissionRevoked ? "revoked" : "disabled",
      );
    return null;
  }
}
