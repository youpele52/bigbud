import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake";
import * as Schema from "effect/Schema";

export interface MobileComposerDraftIdentity {
  readonly backendOrigin: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly authorityId?: string;
}
export interface MobileComposerDraftSessionIdentity {
  readonly backendBaseUrl: string;
  readonly sessionId: string;
  readonly authorityId?: string | null;
}
export function normalizeMobileBackendOrigin(backendBaseUrl: string): string {
  try {
    return new URL(backendBaseUrl).origin;
  } catch {
    return backendBaseUrl.trim().replace(/\/$/, "").toLowerCase();
  }
}
export function makeMobileComposerDraftIdentity(
  input: MobileComposerDraftSessionIdentity & { readonly threadId: string },
): MobileComposerDraftIdentity {
  const authority =
    input.authorityId == null
      ? undefined
      : Schema.decodeUnknownSync(RemoteBackendAuthorityId)(input.authorityId);
  return {
    backendOrigin: normalizeMobileBackendOrigin(input.backendBaseUrl),
    sessionId: input.sessionId,
    threadId: input.threadId,
    ...(authority === undefined ? {} : { authorityId: authority }),
  };
}
function prefix(origin: string, sessionId: string, authorityId?: string | null) {
  const parts =
    authorityId == null
      ? ["bigbud:mobile-composition:v1", origin, sessionId]
      : [
          "bigbud:mobile-composition:v2",
          Schema.decodeUnknownSync(RemoteBackendAuthorityId)(authorityId),
          origin,
          sessionId,
        ];
  return parts.map((part) => encodeURIComponent(part)).join(":");
}
export function mobileComposerDraftSessionPrefix(
  input: MobileComposerDraftSessionIdentity,
): string {
  return prefix(
    normalizeMobileBackendOrigin(input.backendBaseUrl),
    input.sessionId,
    input.authorityId,
  );
}
export function mobileComposerDraftKey(identity: MobileComposerDraftIdentity): string {
  return `${prefix(identity.backendOrigin, identity.sessionId, identity.authorityId)}:${encodeURIComponent(identity.threadId)}`;
}
