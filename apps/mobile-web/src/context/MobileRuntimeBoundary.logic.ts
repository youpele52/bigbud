import { QueryClient } from "@tanstack/react-query";

import {
  bindMobileSessionAuthority,
  getMobileSessionAuthority,
} from "../lib/mobileSessionAuthority";
import type { StoredMobileSession } from "../lib/mobileSession";

const BINDING_FIELDS = [
  "backendBaseUrl",
  "sessionId",
  "sessionToken",
  "scope",
  "expiresAt",
] as const;

/** Effective credentials and privately admitted authority; no persisted field supplies trust. */
export function sameMobileRuntimeSession(
  previous: StoredMobileSession | null,
  next: StoredMobileSession | null,
): boolean {
  if (!previous || !next) return previous === next;
  return (
    getMobileSessionAuthority(previous) === getMobileSessionAuthority(next) &&
    BINDING_FIELDS.every((field) => previous[field] === next[field])
  );
}

/** Retain private admission when taking an immutable runtime binding snapshot. */
export function copyMobileRuntimeSession(session: StoredMobileSession | null) {
  if (!session) return null;
  const copy = { ...session };
  const authority = getMobileSessionAuthority(session);
  return authority ? bindMobileSessionAuthority(copy, authority) : copy;
}

/** Each mounted runtime owns its cache; query keys cannot collide across replacements. */
export function createMobileRuntimeOwner() {
  const queryClient = new QueryClient();
  return {
    queryClient,
    dispose() {
      // Cancel local reads only. Backend work and durable uncertain-command records survive.
      void queryClient.cancelQueries().catch(() => undefined);
      queryClient.clear();
    },
  };
}
