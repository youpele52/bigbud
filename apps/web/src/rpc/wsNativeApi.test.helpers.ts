import {
  DEFAULT_SERVER_SETTINGS,
  type KanbanCard,
  type KanbanDeleteResult,
  type KanbanListResult,
  type DesktopBridge,
  type Note,
  type NotesDeleteResult,
  type NotesListResult,
  type OrchestrationEvent,
  type ProjectDirectoryWatchEvent,
  type ServerConfig,
  type ServerProvider,
  type TerminalEvent,
} from "@bigbud/contracts";
import type { ContextMenuItem } from "@bigbud/contracts";
import { afterEach, beforeEach, vi, type Mock } from "vitest";

import type { WsRpcClient } from "./wsRpcClient";

/** Recursively replaces all function properties with vitest's Mock type. */
type DeepMock<T> = {
  [P in keyof T]: T[P] extends (...args: any[]) => any
    ? Mock
    : T[P] extends object
      ? DeepMock<T[P]>
      : T[P];
};

export const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
export const orchestrationEventListeners = new Set<(event: OrchestrationEvent) => void>();
export const projectDirectoryEventListeners = new Set<
  (event: ProjectDirectoryWatchEvent) => void
>();

export const rpcClientMock: DeepMock<WsRpcClient> = {
  dispose: vi.fn(),
  reconnect: vi.fn(),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  browser: {
    completeCommand: vi.fn(),
    revokeLease: vi.fn(),
    getLeases: vi.fn(),
    onCommand: vi.fn(),
  },
  projects: {
    listDirectory: vi.fn(),
    onDirectoryChange: vi.fn((_, listener: (event: ProjectDirectoryWatchEvent) => void) =>
      registerListener(projectDirectoryEventListeners, listener),
    ),
    readFilePreview: vi.fn(),
    searchFileContents: vi.fn(),
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  notes: {
    list: vi.fn<(...args: any[]) => Promise<NotesListResult>>(),
    get: vi.fn<(...args: any[]) => Promise<Note>>(),
    create: vi.fn<(...args: any[]) => Promise<Note>>(),
    update: vi.fn<(...args: any[]) => Promise<Note>>(),
    delete: vi.fn<(...args: any[]) => Promise<NotesDeleteResult>>(),
  },
  kanban: {
    list: vi.fn<(...args: any[]) => Promise<KanbanListResult>>(),
    get: vi.fn<(...args: any[]) => Promise<KanbanCard>>(),
    create: vi.fn<(...args: any[]) => Promise<KanbanCard>>(),
    update: vi.fn<(...args: any[]) => Promise<KanbanCard>>(),
    delete: vi.fn<(...args: any[]) => Promise<KanbanDeleteResult>>(),
    move: vi.fn<(...args: any[]) => Promise<KanbanCard>>(),
    reorder: vi.fn<(...args: any[]) => Promise<KanbanCard>>(),
  },
  teach: {
    listProjects: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
    openPath: vi.fn(),
  },
  git: {
    pull: vi.fn(),
    fetch: vi.fn(),
    discardChanges: vi.fn(),
    refreshStatus: vi.fn(),
    listCommits: vi.fn(),
    getCommitDetails: vi.fn(),
    readWorkingTreeDiff: vi.fn(),
    runStackedAction: vi.fn(),
    listBranches: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    init: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
    onStatus: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    verifyExecutionTarget: vi.fn(),
    unlockSshKey: vi.fn(),
    unlockSshPassword: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    readDocumentUrl: vi.fn(),
    writeHandoffDocument: vi.fn(),
    startHandoffJob: vi.fn(),
    getHandoffJob: vi.fn(),
    createMobileRemotePairing: vi.fn(),
    listMobileRemoteSessions: vi.fn(),
    revokeMobileRemoteSession: vi.fn(),
    exportThreadContext: vi.fn(),
    getAutomation: vi.fn(),
    listAutomations: vi.fn(),
    listAllAutomations: vi.fn(),
    createAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    pauseAutomation: vi.fn(),
    resumeAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    triggerAutomation: vi.fn(),
    listAutomationRuns: vi.fn(),
    getUsageSummary: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
  },
  orchestration: {
    getSnapshot: vi.fn(),
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    replayEvents: vi.fn(),
    onDomainEvent: vi.fn((listener: (event: OrchestrationEvent) => void) =>
      registerListener(orchestrationEventListeners, listener),
    ),
    onThinkingDelta: vi.fn(),
  },
};

vi.mock("./wsRpcClient", () => {
  return {
    getWsRpcClient: () => rpcClientMock,
    __resetWsRpcClientForTests: vi.fn(),
  };
});

vi.mock("../utils/context-menu", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

export function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

export function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    getMobileBackendBaseUrl: () => null,
    getComputerUseRuntimeStatus: async () => ({
      available: false,
      source: "missing",
      binaryPath: null,
      version: null,
      message: "Computer Use runtime is not installed yet.",
      diagnostics: null,
    }),
    getComputerUsePermissionsStatus: async () => ({
      runtimeAvailable: false,
      granted: false,
      message: "Computer Use runtime is not installed yet.",
      permissions: [],
    }),
    requestComputerUsePermissions: async () => ({
      runtimeAvailable: false,
      granted: false,
      message: "Computer Use runtime is not installed yet.",
      permissions: [],
    }),
    installComputerUseRuntime: async () => ({
      ok: false,
      status: {
        available: false,
        source: "missing",
        binaryPath: null,
        version: null,
        message: "Computer Use runtime is not installed yet.",
        diagnostics: null,
      },
    }),
    runComputerUseDoctor: async () => ({
      available: false,
      source: "missing",
      binaryPath: null,
      version: null,
      message: "Computer Use runtime is not installed yet.",
      diagnostics: null,
    }),
    getTailscaleRemoteAccessStatus: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    enableTailscaleRemoteAccess: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    disableTailscaleRemoteAccess: async () => ({
      installed: false,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: "Tailscale CLI is not installed.",
    }),
    getFilePath: () => "",
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    setWindowMaterial: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    notifications: {
      isSupported: async () => false,
      show: async () => false,
    },
    copyToClipboard: async () => undefined,
    requestFileAccess: async () => ({ success: false, granted: [], denied: [] }),
    ...overrides,
  };
}

export const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

export const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  storage: {
    notesDir: "/tmp/workspace/.config/notes",
    kanbanDir: "/tmp/workspace/.config/kanban",
  },
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  discovery: {
    agents: [],
    skills: [],
  },
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  terminalEventListeners.clear();
  orchestrationEventListeners.clear();
  projectDirectoryEventListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});
