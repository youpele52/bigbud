import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openNewBrowserTabMock = vi.hoisted(() => vi.fn());
const launcherPropsMock = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));

const rightPanelTabsStoreMock = vi.hoisted(() => {
  type RightPanelTabsState = {
    activeKind: "browser" | "diff" | "files" | "git" | "terminal" | null;
    activeTabId: string | null;
    openTabs: ReadonlyArray<string>;
    rightPanelOpen: boolean;
    lastActiveKind: "browser" | "diff" | "files" | "git" | "terminal" | null;
  };

  let state: RightPanelTabsState = {
    activeKind: null,
    activeTabId: null,
    openTabs: [],
    rightPanelOpen: false,
    lastActiveKind: null,
  };

  return {
    useRightPanelTabsStore: Object.assign(
      <T,>(selector: (storeState: RightPanelTabsState) => T) => selector(state),
      {
        setState: (nextState: Partial<RightPanelTabsState>) => {
          state = { ...state, ...nextState };
        },
      },
    ),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { isRepo: true } }),
}));

vi.mock("~/rpc/serverState", () => ({
  useServerKeybindings: () => [],
  useDefaultChatCwd: () => "/workspace",
}));

vi.mock("~/stores/main", () => ({
  useThreadById: () => null,
  useProjectById: () => ({ cwd: "/workspace" }),
}));

vi.mock("~/stores/browser/browserPanel.actions", () => ({
  closeBrowserTab: vi.fn(),
  openNewBrowserTab: openNewBrowserTabMock,
}));

vi.mock("~/stores/ui", () => ({
  useUiStateStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId: "project-1" }),
}));

vi.mock("~/stores/rightPanel/rightPanelTabs.store", () => ({
  getRightPanelTabKind: (tabId: string) => (tabId.startsWith("browser:") ? "browser" : tabId),
  useRightPanelTabsStore: rightPanelTabsStoreMock.useRightPanelTabsStore,
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
  RightPanelLauncher: (props: Record<string, unknown>) => {
    launcherPropsMock.props = props;
    return <div data-testid="right-panel-launcher" />;
  },
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

vi.mock("../git-panel/GitPanel", () => ({
  GitPanelContent: () => <div data-testid="git-panel">git</div>,
}));

vi.mock("../diff/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./openDiffPanel", () => ({
  openDiffPanel: () => undefined,
}));

import { RightPanelHost } from "./RightPanelHost";

describe("RightPanelHost", () => {
  beforeEach(() => {
    rightPanelTabsStoreMock.useRightPanelTabsStore.setState({
      activeKind: "browser",
      activeTabId: "browser:1",
      openTabs: ["browser:1", "browser:2", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "browser",
    });
  });

  afterEach(() => {
    launcherPropsMock.props = null;
    openNewBrowserTabMock.mockReset();
    rightPanelTabsStoreMock.useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
  });

  it("keeps open tab bodies mounted while switching the active tab", () => {
    const browserMarkup = renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(browserMarkup).toContain('data-testid="browser-panel"');
    expect(browserMarkup).toContain('data-testid="files-panel"');
    expect(browserMarkup).toContain('data-testid="terminal-panel"');
    expect(browserMarkup).toContain(
      'aria-hidden="false"><div data-testid="browser-panel">browser</div>',
    );
    expect(browserMarkup).toContain(
      'aria-hidden="true"><div data-testid="browser-panel">browser</div>',
    );
    expect(browserMarkup).toContain(
      'aria-hidden="true"><div data-testid="files-panel">files</div>',
    );
    expect(browserMarkup).toContain(
      'aria-hidden="true"><div data-testid="terminal-panel">terminal</div>',
    );

    rightPanelTabsStoreMock.useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: ["browser:1", "browser:2", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "files",
    });

    const filesMarkup = renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(filesMarkup).toContain('data-testid="browser-panel"');
    expect(filesMarkup).toContain('data-testid="files-panel"');
    expect(filesMarkup).toContain('data-testid="terminal-panel"');
    expect(filesMarkup).toContain(
      'aria-hidden="true"><div data-testid="browser-panel">browser</div>',
    );
    expect(filesMarkup).toContain('aria-hidden="false"><div data-testid="files-panel">files</div>');
    expect(filesMarkup).toContain(
      'aria-hidden="true"><div data-testid="terminal-panel">terminal</div>',
    );
  });

  it("shows the launcher while preserving existing tab bodies when no tab is active", () => {
    rightPanelTabsStoreMock.useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: ["browser:1", "browser:2", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "browser",
    });

    const markup = renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(markup).toContain('data-testid="right-panel-launcher"');
    expect(markup).toContain('data-testid="browser-panel"');
    expect(markup).toContain('data-testid="files-panel"');
    expect(markup).toContain('data-testid="terminal-panel"');
    expect(markup).toContain('aria-hidden="true"><div data-testid="browser-panel">browser</div>');
    expect(markup).toContain('aria-hidden="true"><div data-testid="files-panel">files</div>');
    expect(markup).toContain('aria-hidden="true"><div data-testid="terminal-panel">terminal</div>');
  });

  it("wires the launcher browser action to open a new browser tab", () => {
    rightPanelTabsStoreMock.useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: ["browser:1", "files"],
      rightPanelOpen: true,
      lastActiveKind: "browser",
    });

    renderToStaticMarkup(<RightPanelHost activeThreadId={null} />);

    expect(launcherPropsMock.props).not.toBeNull();
    expect(launcherPropsMock.props?.onToggleBrowser).toBe(openNewBrowserTabMock);
  });
});
