import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import * as Schema from "effect/Schema";

/** Public provenance only. A replacement grant cannot reconcile another grant's mutation. */
export const MobileCommandReceiptSource = Schema.Struct({
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
  backendOrigin: Schema.String,
  sessionId: Schema.String.check(Schema.isMinLength(1)),
});
export type MobileCommandReceiptSourceValue = typeof MobileCommandReceiptSource.Type;
