import type { StoredMobileSession } from "../lib/mobileSession";

export const runtimeIsolationSessions: ReadonlyArray<StoredMobileSession> = [
  {
    sessionId: "same-session-id",
    sessionToken: "fixture-a",
    backendBaseUrl: "https://host-a.invalid",
    websocketUrl: "ignored",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  {
    sessionId: "same-session-id",
    sessionToken: "fixture-b",
    backendBaseUrl: "https://host-b.invalid",
    websocketUrl: "ignored",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
];
