import { decodeStoredMobileSession } from "./mobileSession.codec";

export interface StoredMobileSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly websocketUrl: string;
  readonly backendBaseUrl: string;
  readonly scope: "read-only" | "approve-only" | "thread-control";
  readonly expiresAt: string;
}

const MOBILE_SESSION_STORAGE_KEY = "bigbud:mobile-web:session:v1";

export function readMobileSession(): StoredMobileSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(MOBILE_SESSION_STORAGE_KEY);
    return raw ? decodeStoredMobileSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeMobileSession(session: StoredMobileSession) {
  const decoded = decodeStoredMobileSession(session);
  if (!decoded) throw new Error("The mobile authorization is invalid.");
  window.localStorage.setItem(MOBILE_SESSION_STORAGE_KEY, JSON.stringify(decoded));
}

export function clearMobileSession() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(MOBILE_SESSION_STORAGE_KEY);
}

export function isMobileSessionExpired(session: StoredMobileSession): boolean {
  const expiry = Date.parse(session.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

export function resolveMobileWebsocketUrl(session: StoredMobileSession): string {
  const backend = new URL(session.backendBaseUrl);
  const protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${backend.host}/mobile-ws?token=${encodeURIComponent(session.sessionToken)}`;
}
