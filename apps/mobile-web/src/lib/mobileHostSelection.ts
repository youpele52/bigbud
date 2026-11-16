import { ThreadId } from "@bigbud/contracts";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake";
import * as Schema from "effect/Schema";
import { mobileHostStateKey } from "../logic/mobileHostIdentity.logic";
import { getMobileSessionAuthority } from "./mobileSessionAuthority";

function key(session: object | null | undefined): string | null {
  const authority = getMobileSessionAuthority(session);
  return authority ? mobileHostStateKey(authority, "selection", "thread") : null;
}
/** Reading a selection never authorizes that thread or activates a session. */
export function readMobileSelectedThread(session: object | null | undefined): ThreadId | null {
  const storageKey = key(session);
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(storageKey);
    return raw && raw.length <= 2048 ? Schema.decodeUnknownSync(ThreadId)(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function writeMobileSelectedThread(
  session: object | null | undefined,
  threadId: ThreadId,
): boolean {
  const storageKey = key(session);
  if (!storageKey) return false;
  try {
    const raw = JSON.stringify(Schema.decodeUnknownSync(ThreadId)(threadId));
    localStorage.setItem(storageKey, raw);
    return localStorage.getItem(storageKey) === raw;
  } catch {
    return false;
  }
}
export function clearMobileSelectedThread(session: object | null | undefined): boolean {
  const storageKey = key(session);
  if (!storageKey) return false;
  try {
    localStorage.removeItem(storageKey);
    return localStorage.getItem(storageKey) === null;
  } catch {
    return false;
  }
}

/** Offline explicit Forget needs no live admission to delete that host's local selection. */
export function clearMobileSelectedThreadForAuthority(authorityId: string): boolean {
  try {
    const id = Schema.decodeUnknownSync(RemoteBackendAuthorityId)(authorityId);
    const storageKey = mobileHostStateKey(id, "selection", "thread");
    localStorage.removeItem(storageKey);
    return localStorage.getItem(storageKey) === null;
  } catch {
    return false;
  }
}
