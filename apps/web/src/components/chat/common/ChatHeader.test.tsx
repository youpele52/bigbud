import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BINDINGS } from "../../../models/keybindings/keybindings.models.test.helpers";
import { useBrowserPanelStore } from "../../../stores/browser/browser.store";
import { SidebarProvider } from "../../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
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
});
