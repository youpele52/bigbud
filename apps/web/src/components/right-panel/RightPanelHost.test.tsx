import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resetRightPanelTabsState, useRightPanelTabsStoreMock } = vi.hoisted(() => {
  const initialState = {
    activeKind: null,
    openTabs: [] as Array<"browser" | "files" | "terminal" | "diff">,
    rightPanelOpen: false,
    lastActiveKind: null,
    closeTab: () => undefined,
    ensureTabOpen: () => undefined,
    openTab: () => undefined,
    setActiveTab: () => undefined,
    toggleRightPanel: () => undefined,
    openRightPanel: () => undefined,
    closeRightPanel: () => undefined,
  };

  const state = { ...initialState };
  const resetState = () => {
    Object.assign(state, initialState);
  };

  const store = Object.assign((selector: (snapshot: typeof state) => unknown) => selector(state), {
    setState: (partial: Partial<typeof state>) => {
      Object.assign(state, partial);
    },
  });

  return {
    resetRightPanelTabsState: resetState,
    useRightPanelTabsStoreMock: store,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("~/rpc/serverState", () => ({
  useServerKeybindings: () => [],
  useDefaultChatCwd: () => "/workspace",
}));

vi.mock("~/stores/main", () => ({
  useThreadById: () => null,
  useProjectById: () => ({ cwd: "/workspace" }),
}));

vi.mock("~/stores/ui", () => ({
  useUiStateStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId: "project-1" }),
}));

vi.mock("~/stores/rightPanel/rightPanelTabs.store", () => ({
  useRightPanelTabsStore: useRightPanelTabsStoreMock,
}));

vi.mock("./useRightPanelWidth", () => ({
  useRightPanelWidth: () => ({ panelWidth: 480, onResizePointerDown: () => undefined }),
}));

vi.mock("./RightPanelShell", () => ({
  RightPanelShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="right-panel-shell">{children}</div>
  ),
}));

vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: () => <div data-testid="right-panel-tabs" />,
}));

vi.mock("./RightPanelLauncher", () => ({
  RightPanelLauncher: () => <div data-testid="right-panel-launcher" />,
}));

vi.mock("../browser/BrowserPanel", () => ({
  BrowserPanelContent: () => <div data-testid="browser-panel">browser</div>,
}));

vi.mock("../files/FilesPanel", () => ({
  FilesPanelContent: () => <div data-testid="files-panel">files</div>,
}));

vi.mock("../terminal/TerminalPanel", () => ({
  TerminalPanelContent: () => <div data-testid="terminal-panel">terminal</div>,
}));

vi.mock("../diff/DiffPanel", () => ({
  default: () => <div data-testid="diff-panel">diff</div>,
}));

vi.mock("../diff/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./openDiffPanel", () => ({
  openDiffPanel: () => undefined,
}));

import { RightPanelHost } from "./RightPanelHost";
import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";

describe("RightPanelHost", () => {
  beforeEach(() => {
    resetRightPanelTabsState();
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "browser",
    });
  });

  afterEach(() => {
    resetRightPanelTabsState();
    useRightPanelTabsStore.setState({
      activeKind: null,
      openTabs: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
  });

  it("keeps open tab bodies mounted while switching the active tab", () => {
    const initialMarkup = renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(initialMarkup).toContain('data-testid="browser-panel"');
    expect(initialMarkup).toContain('data-testid="files-panel"');
    expect(initialMarkup).toContain('data-testid="terminal-panel"');
    expect(initialMarkup).toContain('aria-hidden="false"');
    expect(initialMarkup).toContain("pointer-events-none invisible");

    useRightPanelTabsStore.setState({
      activeKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "files",
    });
    const switchedMarkup = renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(switchedMarkup).toContain('data-testid="browser-panel"');
    expect(switchedMarkup).toContain('data-testid="files-panel"');
    expect(switchedMarkup).toContain('data-testid="terminal-panel"');
    expect(switchedMarkup).toContain('aria-hidden="false"');
    expect(switchedMarkup).toContain("pointer-events-none invisible");
  });
});
