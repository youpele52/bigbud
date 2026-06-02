import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockIsThreadRunning = false;
let mockIsThreadCompacting = false;

vi.mock("../../../stores/main", async () => {
  const actual =
    await vi.importActual<typeof import("../../../stores/main")>("../../../stores/main");

  return {
    ...actual,
    useIsThreadRunning: () => mockIsThreadRunning,
    useIsThreadCompacting: () => mockIsThreadCompacting,
  };
});

import { DEFAULT_BINDINGS } from "../../../models/keybindings/keybindings.models.test.helpers";
import { useBrowserPanelStore } from "../../../stores/browser/browser.store";
import { useStore } from "../../../stores/main";
import { SidebarProvider } from "../../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockIsThreadRunning = false;
    mockIsThreadCompacting = false;
    useBrowserPanelStore.setState({ open: false, url: "" });
    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: false,
    });
  });

  const baseProps = {
    activeProjectScripts: undefined,
    activeProjectName: undefined,
    activeThreadTitle: "Thread",
    availableEditors: [],
    browserOpen: false,
    browserToggleShortcutLabel: null,
    diffOpen: false,
    diffToggleShortcutLabel: null,
    filesOpen: false,
    filesToggleShortcutLabel: null,
    gitCwd: null,
    isGitRepo: true,
    keybindings: DEFAULT_BINDINGS,
    onAddProjectScript: async () => undefined,
    onDeleteProjectScript: async () => undefined,
    onRunProjectScript: () => undefined,
    onToggleBrowser: () => undefined,
    onToggleDiff: () => undefined,
    onToggleFiles: () => undefined,
    onToggleTerminal: () => undefined,
    onUpdateProjectScript: async () => undefined,
    openInCwd: null,
    preferredScriptId: null,
    sidebarToggleShortcutLabel: null,
    terminalAvailable: true,
    terminalOpen: false,
    terminalPanelToggleShortcutLabel: null,
    terminalToggleShortcutLabel: null,
  } as const;

  it("renders the browser toggle immediately before the diff toggle", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader activeThreadId={"thread-1" as never} {...baseProps} />
      </SidebarProvider>,
    );

    expect(markup.indexOf('aria-label="Toggle terminal panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle browser panel"'),
    );
    expect(markup.indexOf('aria-label="Toggle browser panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle diff panel"'),
    );
  });

  it("shows blue dots while running and orange dots while compacting", () => {
    mockIsThreadRunning = true;

    const runningMarkup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader activeThreadId={"thread-running" as never} {...baseProps} />
      </SidebarProvider>,
    );

    mockIsThreadRunning = false;
    mockIsThreadCompacting = true;

    const compactingMarkup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader activeThreadId={"thread-compacting" as never} {...baseProps} />
      </SidebarProvider>,
    );

    expect(runningMarkup).toContain("bg-info-foreground");
    expect(compactingMarkup).toContain("bg-warning");
  });
});
