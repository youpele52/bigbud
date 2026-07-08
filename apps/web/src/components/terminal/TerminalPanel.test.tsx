import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockUseServerKeybindings = vi.fn(() => []);
const mockUseTerminalPanelStore = vi.fn((selector: (state: { open: boolean }) => unknown) =>
  selector({ open: true }),
);
const mockUseTerminalStateStore = vi.fn(
  (
    selector: (state: {
      panelTerminalStateByThreadId: Record<string, unknown>;
      ensurePanelTerminal: () => void;
    }) => unknown,
  ) =>
    selector({
      panelTerminalStateByThreadId: {},
      ensurePanelTerminal: () => undefined,
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
  it("waits for explicit panel terminal state before mounting the terminal viewport", () => {
    const markup = renderToStaticMarkup(
      <TerminalPanelContent activeThreadId={"thread-1" as never} />,
    );

    expect(markup).toContain("Initializing terminal...");
    expect(markup).not.toContain('data-testid="thread-terminal-drawer"');
  });
});
