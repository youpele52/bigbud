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
import { useRightPanelTabsStore } from "../../../stores/rightPanel/rightPanelTabs.store";
import { SidebarProvider } from "../../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockIsThreadRunning = false;
    mockIsThreadCompacting = false;
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
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
    diffOpen: false,
    keybindings: DEFAULT_BINDINGS,
    onAddProjectScript: async () => undefined,
    onDeleteProjectScript: async () => undefined,
    onOpenOrchestra: () => undefined,
    onRunProjectScript: () => undefined,
    onToggleRightPanel: () => undefined,
    onUpdateProjectScript: async () => undefined,
    openInCwd: null,
    preferredScriptId: null,
    rightPanelOpen: false,
    rightPanelToggleShortcutLabel: null,
    sidebarToggleShortcutLabel: null,
  } as const;

  it("renders the sidebar toggle and the right panel toggle", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader activeThreadId={"thread-1" as never} {...baseProps} />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Toggle sidebar"');
    expect(markup).toContain('aria-label="Open right panel"');
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

  it("renders quick actions when chat has an open folder without a project header", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader
          activeThreadId={"thread-chat-folder" as never}
          {...baseProps}
          openInCwd="/repo/project"
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Quick actions"');
  });
});
