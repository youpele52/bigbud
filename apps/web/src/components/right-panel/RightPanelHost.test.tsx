import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";

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

describe("RightPanelHost", () => {
  beforeEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "browser",
    });
  });

  afterEach(() => {
    cleanup();
    useRightPanelTabsStore.setState({
      activeKind: null,
      openTabs: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
  });

  it("keeps open tab bodies mounted while switching the active tab", () => {
    const { rerender } = render(<RightPanelHost activeThreadId={null} />);

    const browserPanel = screen.getByTestId("browser-panel");
    const filesPanel = screen.getByTestId("files-panel");
    const terminalPanel = screen.getByTestId("terminal-panel");

    expect(browserPanel.parentElement).not.toHaveClass("invisible");
    expect(filesPanel.parentElement).toHaveClass("invisible");
    expect(terminalPanel.parentElement).toHaveClass("invisible");

    useRightPanelTabsStore.setState({
      activeKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
      lastActiveKind: "files",
    });
    rerender(<RightPanelHost activeThreadId={null} />);

    expect(screen.getByTestId("browser-panel")).toBe(browserPanel);
    expect(screen.getByTestId("files-panel")).toBe(filesPanel);
    expect(screen.getByTestId("terminal-panel")).toBe(terminalPanel);
    expect(browserPanel.parentElement).toHaveClass("invisible");
    expect(filesPanel.parentElement).not.toHaveClass("invisible");
    expect(terminalPanel.parentElement).toHaveClass("invisible");
  });
});
