import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  MobileRemoteControlAdmission,
  decodeRemoteMobileAdmissionStamp,
  mobileAdmissionStampEqual,
  type RemoteMobileAdmissionStamp,
} from "../Services/MobileRemoteControlAdmission.ts";

export const currentMobileRecordAdmission = Effect.serviceOption(MobileRemoteControlAdmission);

export function mobileRecordAdmissionFields(admission: Option.Option<RemoteMobileAdmissionStamp>) {
  return Option.isSome(admission) ? { remoteAdmission: admission.value } : {};
}

export function matchesMobileRecordAdmission(
  record: { readonly remoteAdmission?: unknown },
  admission: Option.Option<RemoteMobileAdmissionStamp>,
): boolean {
  // Legacy desktop grants stay legacy. A remote-stamped grant cannot downgrade to that path.
  if (Option.isNone(admission)) return record.remoteAdmission === undefined;
  const stored = decodeRemoteMobileAdmissionStamp(record.remoteAdmission);
  return stored !== null && mobileAdmissionStampEqual(stored, admission.value);
}
