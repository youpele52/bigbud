import { getMobileSessionAuthority, mobileSessionStateScope } from "./mobileSessionAuthority";
import type { ThreadId } from "@bigbud/contracts";

const STORAGE_KEY = "bigbud:mobile-thread-last-visited";
type SessionScope = { readonly sessionId: string } | null | undefined;
function storageKey(session: SessionScope) {
  return session && getMobileSessionAuthority(session)
    ? `${STORAGE_KEY}:${mobileSessionStateScope(session, "selection")}`
    : STORAGE_KEY;
}
function readVisitMap(session?: SessionScope): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(storageKey(session));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    );
  } catch {
    return {};
  }
}

export function markThreadVisited(
  threadId: ThreadId,
  visitedAt = new Date().toISOString(),
  session?: SessionScope,
) {
  if (typeof window === "undefined") return;
  try {
    const next = { ...readVisitMap(session), [threadId]: visitedAt };
    localStorage.setItem(storageKey(session), JSON.stringify(next));
  } catch {
    // Optional presentation metadata must not interrupt conversation or command ownership.
  }
}
export function getThreadLastVisitedAt(
  threadId: ThreadId,
  session?: SessionScope,
): string | undefined {
  const visits = readVisitMap(session);
  return Object.hasOwn(visits, threadId) ? visits[threadId] : undefined;
}
