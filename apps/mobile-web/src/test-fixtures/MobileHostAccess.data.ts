import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerConfig } from "@bigbud/contracts/server/server";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import type { StoredMobileSession } from "../lib/mobileSession";
import { parityProviders } from "./MobileParityReference.data";

// Disposable protocol data only; true readiness here never changes the production producer.
export const hostAccessDescriptors: Record<"A" | "B", RemoteBackendMobileDescriptor> = {
  A: {
    handshakeRevision: 1,
    authority: {
      authorityId: "a".repeat(32),
      keyFingerprint: `sha256:${"c".repeat(64)}`,
      keyEpoch: 1,
    },
    installationFingerprint: `sha256:${"e".repeat(64)}`,
    backendVersion: "fixture",
    mobileRpcRevision: 1,
    mobileCapable: true,
  },
  B: {
    handshakeRevision: 1,
    authority: {
      authorityId: "b".repeat(32),
      keyFingerprint: `sha256:${"d".repeat(64)}`,
      keyEpoch: 1,
    },
    installationFingerprint: `sha256:${"f".repeat(64)}`,
    backendVersion: "fixture",
    mobileRpcRevision: 1,
    mobileCapable: true,
  },
};
export const hostAccessSessions: Record<"A" | "B", StoredMobileSession> = {
  A: {
    sessionId: "same-session-id",
    sessionToken: "fixture-host-a",
    backendBaseUrl: "https://host-a.invalid",
    websocketUrl: "ignored",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  B: {
    sessionId: "same-session-id",
    sessionToken: "fixture-host-b",
    backendBaseUrl: "https://host-b.invalid",
    websocketUrl: "ignored",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
export const hostAccessConfig: ServerConfig = {
  cwd: "/fixture",
  storage: { notesDir: "/fixture/notes", kanbanDir: "/fixture/kanban" },
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: parityProviders.map((provider) =>
    Object.assign({}, provider, { initialProbeComplete: true }),
  ),
  discovery: { agents: [], skills: [] },
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    ...DEFAULT_CLIENT_SETTINGS,
    mobileRemoteControl: { ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl, enabled: true },
  },
};
