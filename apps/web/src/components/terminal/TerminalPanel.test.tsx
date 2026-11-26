import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseServerKeybindings = vi.fn(() => []);
const mockUseTerminalPanelStore = vi.fn((selector: (state: { open: boolean }) => unknown) =>
  selector({ open: true }),
);
const mockNewPanelTerminal = vi.fn();
const mockEnsurePanelTerminal = vi.fn();
let mockPanelTerminalStateByThreadId: Record<string, { terminalIds: string[] }> = {};
const mockUseTerminalStateStore = vi.fn(
  (
    selector: (state: {
      panelTerminalStateByThreadId: Record<string, { terminalIds: string[] }>;
      newPanelTerminal: typeof mockNewPanelTerminal;
      ensurePanelTerminal: typeof mockEnsurePanelTerminal;
    }) => unknown,
  ) =>
    selector({
      panelTerminalStateByThreadId: mockPanelTerminalStateByThreadId,
      newPanelTerminal: mockNewPanelTerminal,
      ensurePanelTerminal: mockEnsurePanelTerminal,
    }),
);
const mockUseThreadTerminalDrawer = vi.fn(() => ({
  cwd: "/workspace",
  project: { id: "project-1", cwd: "/workspace" },
  executionTargetId: undefined,
  effectiveWorktreePath: null,
  runtimeEnv: {},
  focusRequestId: 0,
  terminalBaseLabel: "workspace",
  terminalProvider: "codex",
  splitTerminal: () => undefined,
  createNewTerminal: () => undefined,
  activateTerminal: () => undefined,
  closeTerminal: () => undefined,
  setTerminalHeight: () => undefined,
  bumpFocusRequestId: () => undefined,
  terminalState: {
    terminalHeight: 280,
    terminalIds: ["default"],
    activeTerminalId: "default",
    terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
    activeTerminalGroupId: "group-default",
  },
}));

vi.mock("../../rpc/serverState", () => ({
  useServerKeybindings: () => mockUseServerKeybindings(),
}));

vi.mock("../../stores/terminal", () => ({
  useTerminalStateStore: (selector: Parameters<typeof mockUseTerminalStateStore>[0]) =>
    mockUseTerminalStateStore(selector),
}));

vi.mock("../../stores/terminal/terminalPanel.store", () => ({
  useTerminalPanelStore: (selector: Parameters<typeof mockUseTerminalPanelStore>[0]) =>
    mockUseTerminalPanelStore(selector),
}));

vi.mock("./useThreadTerminalDrawer", () => ({
  useThreadTerminalDrawer: () => mockUseThreadTerminalDrawer(),
}));

vi.mock("./ThreadTerminalDrawer", () => ({
  default: () => <div data-testid="thread-terminal-drawer">drawer</div>,
}));

import { TerminalPanelContent } from "./TerminalPanel";

describe("TerminalPanelContent", () => {
  beforeEach(() => {
    mockPanelTerminalStateByThreadId = {};
    mockNewPanelTerminal.mockClear();
    mockEnsurePanelTerminal.mockClear();
  });

  it("shows an empty state with New terminal and creates no terminal for a thread without one", () => {
    const markup = renderToStaticMarkup(
      <TerminalPanelContent activeThreadId={"thread-1" as never} />,
    );

    expect(markup).toContain("No terminal in this thread.");
    expect(markup).toContain("New terminal");
    expect(markup).not.toContain('data-testid="thread-terminal-drawer"');
    expect(mockNewPanelTerminal).not.toHaveBeenCalled();
    expect(mockEnsurePanelTerminal).not.toHaveBeenCalled();
  });

  it("treats an emptied panel surface as having no terminal", () => {
    mockPanelTerminalStateByThreadId = { "thread-1": { terminalIds: [] } };
    const markup = renderToStaticMarkup(
      <TerminalPanelContent activeThreadId={"thread-1" as never} />,
    );

    expect(markup).toContain("No terminal in this thread.");
  });

  it("mounts the terminal viewport when the thread has panel terminals", () => {
    mockPanelTerminalStateByThreadId = { "thread-1": { terminalIds: ["terminal-a"] } };
    const markup = renderToStaticMarkup(
      <TerminalPanelContent activeThreadId={"thread-1" as never} />,
    );

    expect(markup).toContain('data-testid="thread-terminal-drawer"');
    expect(markup).not.toContain("No terminal in this thread.");
  });
});
