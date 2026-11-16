import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";

const Stamp = Schema.Struct({
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
  consentRevision: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  backendExternalOrigin: Schema.String.check(Schema.isMaxLength(2048)),
});
export type RemoteMobileAdmissionStamp = typeof Stamp.Type;

/** Private record metadata, never a browser-supplied owner or a wire token format. */
export function decodeRemoteMobileAdmissionStamp(
  value: unknown,
): RemoteMobileAdmissionStamp | null {
  try {
    const decoded = Schema.decodeUnknownSync(Stamp)(value, { onExcessProperty: "error" });
    const url = new URL(decoded.backendExternalOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== decoded.backendExternalOrigin ||
      url.username ||
      url.password
    )
      return null;
    return Object.freeze({ ...decoded, authority: Object.freeze({ ...decoded.authority }) });
  } catch {
    return null;
  }
}
export function mobileAdmissionStampEqual(
  a: RemoteMobileAdmissionStamp,
  b: RemoteMobileAdmissionStamp,
): boolean {
  return (
    compareRemoteBackendIdentity(a, b) === "match" &&
    a.consentRevision === b.consentRevision &&
    a.backendExternalOrigin === b.backendExternalOrigin
  );
}

/** Supplied only for one admitted remote operation; absent for legacy desktop operations. */
export class MobileRemoteControlAdmission extends ServiceMap.Service<
  MobileRemoteControlAdmission,
  RemoteMobileAdmissionStamp
>()("bigbud/mobile/Services/MobileRemoteControlAdmission") {}
