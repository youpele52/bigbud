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
  const raw = window.localStorage.getItem(MOBILE_SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredMobileSession;
  } catch {
    return null;
  }
}

export function writeMobileSession(session: StoredMobileSession) {
  window.localStorage.setItem(MOBILE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearMobileSession() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(MOBILE_SESSION_STORAGE_KEY);
}

export function isMobileSessionExpired(session: StoredMobileSession): boolean {
  return Date.parse(session.expiresAt) <= Date.now();
}

export function resolveMobileWebsocketUrl(session: StoredMobileSession): string {
  const backend = new URL(session.backendBaseUrl);
  const protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${backend.host}/mobile-ws?token=${encodeURIComponent(session.sessionToken)}`;
}
