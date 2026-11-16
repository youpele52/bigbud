import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake";
import * as Schema from "effect/Schema";
import { mobileHostStateKey, type MobileHostStateArea } from "../logic/mobileHostIdentity.logic";
import type { StoredMobileSession } from "./mobileSession";

const admittedAuthorities = new WeakMap<object, string>();

/** Only the verified admission owner may bind a runtime session; JSON fields confer no trust. */
export function bindMobileSessionAuthority<T extends StoredMobileSession>(
  session: T,
  authorityId: string,
): T {
  const authority = Schema.decodeUnknownSync(RemoteBackendAuthorityId)(authorityId);
  const previous = admittedAuthorities.get(session);
  if (previous !== undefined && previous !== authority)
    throw new Error("A mobile session cannot change backend authority.");
  admittedAuthorities.set(session, authority);
  return session;
}
export function getMobileSessionAuthority(session: object | null | undefined): string | null {
  return session ? (admittedAuthorities.get(session) ?? null) : null;
}
export function mobileSessionStateScope(
  session: { readonly sessionId: string },
  area: MobileHostStateArea,
): string {
  const authority = getMobileSessionAuthority(session);
  return authority ? mobileHostStateKey(authority, area, session.sessionId) : session.sessionId;
}
