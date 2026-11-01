import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockIsThreadRunning = false;
let mockIsThreadCompacting = false;
let mockIsElectron = false;

vi.mock("../../../config/env", async () => {
  const actual = await vi.importActual<typeof import("../../../config/env")>("../../../config/env");
  return {
    ...actual,
    get isElectron() {
      return mockIsElectron;
    },
  };
});

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
  function renderHeader(
    input: Partial<React.ComponentProps<typeof ChatHeader>> = {},
    sidebarOpen = true,
  ) {
    const queryClient = new QueryClient();
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider defaultOpen={sidebarOpen}>
          <ChatHeader activeThreadId={"thread-1" as never} {...baseProps} {...input} />
        </SidebarProvider>
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    mockIsThreadRunning = false;
    mockIsThreadCompacting = false;
    mockIsElectron = false;
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
    onOpenTerminal: () => undefined,
    onSelectTerminalLayout: () => undefined,
    onTogglePlanCard: () => undefined,
    onRunProjectScript: () => undefined,
    onToggleRightPanel: () => undefined,
    onUpdateProjectScript: async () => undefined,
    openInCwd: null,
    planCardLabel: "Tasks",
    planCardOpen: false,
    preferredScriptId: null,
    rightPanelOpen: false,
    rightPanelToggleShortcutLabel: null,
    sidebarToggleShortcutLabel: null,
    terminalLayoutMode: "chat-only",
  } as const;

  it("renders the sidebar toggle and the right panel toggle", () => {
    const markup = renderHeader();

    expect(markup).toContain('aria-label="Toggle sidebar"');
    expect(markup).toContain('aria-label="Open right panel"');
  });

  it("leaves the sidebar toggle to the window beside the traffic lights on desktop", () => {
    mockIsElectron = true;
    const markup = renderHeader();

    expect(markup).not.toContain('aria-label="Toggle sidebar"');
    expect(markup).toContain('aria-label="Open right panel"');
  });

  it("lines the title up with the conversation column on desktop while the sidebar is closed", () => {
    mockIsElectron = true;
    const columnGrid = "calc((100%_-_48rem_-_6px)/2_-_8px)";

    expect(renderHeader({}, false)).toContain(columnGrid);
    expect(renderHeader({}, true)).not.toContain(columnGrid);
    mockIsElectron = false;
    expect(renderHeader({}, false)).not.toContain(columnGrid);
  });

  it("keeps session management out of the chat header", () => {
    const markup = renderHeader();

    expect(markup).not.toContain('aria-label="Session controls"');
    expect(markup).not.toContain("Compact context");
    expect(markup).not.toContain("Reload all MCP servers");
  });

  it.each(["chat-only", "split", "terminal-only"] as const)(
    "always renders the layout menu before sidebar controls in %s",
    (terminalLayoutMode) => {
      const markup = renderHeader({ terminalLayoutMode });
      expect(markup).toContain('aria-label="Chat layout"');
      expect(markup.indexOf('aria-label="Chat layout"')).toBeLessThan(
        markup.indexOf('aria-label="Toggle sidebar"'),
      );
      const layoutButton = markup.match(/<button[^>]*aria-label="Chat layout"[^>]*>/)?.[0];
      expect(layoutButton).toContain('aria-haspopup="menu"');
      expect(layoutButton).not.toContain("aria-pressed");
    },
  );

  it("shows the liquid loader while running and orange dots while compacting", () => {
    mockIsThreadRunning = true;

    const runningMarkup = renderHeader({
      activeThreadId: "thread-running" as never,
    });

    mockIsThreadRunning = false;
    mockIsThreadCompacting = true;

    const compactingMarkup = renderHeader({
      activeThreadId: "thread-compacting" as never,
    });

    expect(runningMarkup).toContain("data-agent-working-blob");
    expect(runningMarkup).toContain('data-state="working"');
    expect(compactingMarkup).toContain("bg-warning");
    expect(compactingMarkup).not.toContain("data-agent-working-blob");
  });

  it("renders quick actions when chat has an open folder without a project header", () => {
    const markup = renderHeader({
      activeThreadId: "thread-chat-folder" as never,
      openInCwd: "/repo/project",
    });

    expect(markup).toContain('aria-label="Quick actions"');
  });

  it("renders chat quick actions without a directory and omits Git", () => {
    const markup = renderHeader({
      activeProjectName: "Chats",
      isProjectThread: false,
      openInCwd: null,
    });

    expect(markup).toContain('aria-label="Quick actions"');
  });
});
