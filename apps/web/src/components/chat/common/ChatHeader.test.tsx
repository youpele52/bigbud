import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BINDINGS } from "../../../models/keybindings/keybindings.models.test.helpers";
import { useBrowserPanelStore } from "../../../stores/browser/browser.store";
import { useStore } from "../../../stores/main";
import { SidebarProvider } from "../../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: false,
    });
  });

  it("renders the browser toggle immediately before the diff toggle", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader
          activeThreadId={"thread-1" as never}
          activeThreadTitle="Thread"
          activeProjectName={undefined}
          isGitRepo
          openInCwd={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={DEFAULT_BINDINGS}
          availableEditors={[]}
          terminalAvailable
          terminalOpen={false}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          sidebarToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          gitCwd={null}
          diffOpen={false}
          browserOpen={false}
          onRunProjectScript={() => undefined}
          onAddProjectScript={async () => undefined}
          onUpdateProjectScript={async () => undefined}
          onDeleteProjectScript={async () => undefined}
          onToggleTerminal={() => undefined}
          onToggleDiff={() => undefined}
          onToggleBrowser={() => undefined}
        />
      </SidebarProvider>,
    );

    expect(markup.indexOf('aria-label="Toggle terminal drawer"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle browser panel"'),
    );
    expect(markup.indexOf('aria-label="Toggle browser panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle diff panel"'),
    );
  });

  it("shows blue dots while running and orange dots while compacting", () => {
    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadsById: {
        "thread-running": {
          id: "thread-running" as never,
          projectId: "project-1" as never,
          title: "Running thread",
          interactionMode: "default",
          session: {
            provider: "opencode",
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: "turn-1" as never,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
        "thread-compacting": {
          id: "thread-compacting" as never,
          projectId: "project-1" as never,
          title: "Compacting thread",
          interactionMode: "default",
          session: {
            provider: "opencode",
            status: "running",
            orchestrationStatus: "running",
            reason: "context.compacting",
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      },
      threadIdsByProjectId: {},
      bootstrapComplete: true,
    });

    const runningMarkup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader
          activeThreadId={"thread-running" as never}
          activeThreadTitle="Thread"
          activeProjectName={undefined}
          isGitRepo
          openInCwd={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={DEFAULT_BINDINGS}
          availableEditors={[]}
          terminalAvailable
          terminalOpen={false}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          sidebarToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          gitCwd={null}
          diffOpen={false}
          browserOpen={false}
          onRunProjectScript={() => undefined}
          onAddProjectScript={async () => undefined}
          onUpdateProjectScript={async () => undefined}
          onDeleteProjectScript={async () => undefined}
          onToggleTerminal={() => undefined}
          onToggleDiff={() => undefined}
          onToggleBrowser={() => undefined}
        />
      </SidebarProvider>,
    );
    const compactingMarkup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <ChatHeader
          activeThreadId={"thread-compacting" as never}
          activeThreadTitle="Thread"
          activeProjectName={undefined}
          isGitRepo
          openInCwd={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={DEFAULT_BINDINGS}
          availableEditors={[]}
          terminalAvailable
          terminalOpen={false}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          sidebarToggleShortcutLabel={null}
          browserToggleShortcutLabel={null}
          gitCwd={null}
          diffOpen={false}
          browserOpen={false}
          onRunProjectScript={() => undefined}
          onAddProjectScript={async () => undefined}
          onUpdateProjectScript={async () => undefined}
          onDeleteProjectScript={async () => undefined}
          onToggleTerminal={() => undefined}
          onToggleDiff={() => undefined}
          onToggleBrowser={() => undefined}
        />
      </SidebarProvider>,
    );

    expect(runningMarkup).toContain("bg-info-foreground");
    expect(compactingMarkup).toContain("bg-warning");
  });
});
