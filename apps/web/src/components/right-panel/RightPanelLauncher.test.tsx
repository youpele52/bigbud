import { Folder02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RightPanelLauncher } from "./RightPanelLauncher";

describe("RightPanelLauncher", () => {
  it("uses Folder02 artwork for the large Files tile", () => {
    const onToggle = vi.fn();
    const markup = renderToStaticMarkup(
      <RightPanelLauncher
        browserShortcutLabel={null}
        diffShortcutLabel={null}
        filesShortcutLabel={null}
        gitShortcutLabel={null}
        hasActiveProject
        isGitRepo
        onToggleBrowser={onToggle}
        onToggleDiff={onToggle}
        onToggleFiles={onToggle}
        onToggleGit={onToggle}
        onToggleKanban={onToggle}
        onToggleNotes={onToggle}
        onToggleSystem={onToggle}
        onToggleTerminal={onToggle}
        terminalAvailable
        terminalShortcutLabel={null}
      />,
    );
    const filesIcon = renderToStaticMarkup(
      <HugeiconsIcon
        aria-hidden="true"
        className="size-7 text-foreground"
        icon={Folder02Icon}
        size={14}
        strokeWidth={1.5}
      />,
    );
    expect(markup).toContain(filesIcon);
    expect(markup).not.toContain("lucide-folders");
  });
});
