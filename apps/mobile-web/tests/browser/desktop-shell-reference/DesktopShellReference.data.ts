import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@bigbud/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";
import type { useCompactChatThread } from "~/hooks/useCompactChatThread";
import { parityProviders } from "../../../src/test-fixtures/MobileParityReference.data";
import {
  parityShellProjectId,
  parityShellThreadId,
} from "../../../src/test-fixtures/MobileParityReference.shell.data";

// Shape follows the existing desktop browser fixture; paths are fictional display data only.
export const parityShellServerConfig: ServerConfig = {
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
  settings: { ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS },
};

/** A ready view model, not the bootstrap hook or an authenticated/provider-running claim. */
export const parityCompactChat: ReturnType<typeof useCompactChatThread> = {
  isMaterialized: false,
  loadMoreProjects: async () => {},
  loadProjectThreads: async () => {},
  newChat: async () => true,
  preparing: false,
  projectLoadError: null,
  projectId: parityShellProjectId,
  projectName: "Fixture project",
  retryProjectLoad: () => {},
  retryThreadSync: () => {},
  selectionUnavailable: false,
  selectThread: async () => true,
  synchronizeMaterializedThread: async () => {},
  threadSyncError: null,
  threadTitle: null,
  threadId: parityShellThreadId,
  workspaceRoot: undefined,
};
