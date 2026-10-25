import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ThreadTerminalDrawerViewport", () => ({ ThreadTerminalDrawerViewport: () => null }));

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const baseProps: ComponentProps<typeof ThreadTerminalDrawer> = {
  threadId: "thread-a" as never,
  cwd: "/repo",
  height: 333,
  terminalIds: ["terminal-1"],
  activeTerminalId: "terminal-1",
  terminalGroups: [],
  activeTerminalGroupId: "group-terminal-1",
  focusRequestId: 0,
  keybindings: [],
  terminalBaseLabel: "Terminal",
  terminalLabelOverrides: {},
  terminalProviderById: {},
  onSplitTerminal: () => undefined,
  onNewTerminal: () => undefined,
  onActiveTerminalChange: () => undefined,
  onCloseTerminal: () => undefined,
  onHeightChange: () => undefined,
  onAddTerminalContext: () => undefined,
  onSetTerminalLabelOverride: () => undefined,
  onClearTerminalLabelOverride: () => undefined,
  onToggleExpanded: () => undefined,
};

function expectToolbar(markup: string, labels: string[]) {
  // Sidebar row-close buttons can share the toolbar's accessible names.
  const buttons = (markup.match(/<button[^>]+aria-label="[^"]+"[^>]*>/g) ?? []).filter((button) =>
    button.includes("transition-colors"),
  );
  expect(buttons.map((button) => button.match(/aria-label="([^"]+)"/)?.[1])).toEqual(labels);
  expect(markup).toContain("lucide-x");
  expect(markup).not.toContain("lucide-trash");
  for (const button of buttons) {
    expect(button).toContain("text-muted-foreground");
    expect(button).toContain("hover:text-foreground");
    expect(button).toContain("focus-visible:text-foreground");
  }
  const dividers = markup.match(/<div class="[^"]*w-px bg-border\/[^"]+"><\/div>/g) ?? [];
  const dividerAfterButtonIndices = labels.length === 5 ? [0, 2, 3] : [0, 2];
  expect(dividers).toHaveLength(dividerAfterButtonIndices.length);
  for (const [index, buttonIndex] of dividerAfterButtonIndices.entries()) {
    // Identical divider markup needs a forward search to preserve its position.
    const position = markup.indexOf(dividers[index]!, markup.indexOf(buttons[buttonIndex]!));
    expect(position).toBeGreaterThan(markup.indexOf(buttons[buttonIndex]!));
    expect(position).toBeLessThan(markup.indexOf(buttons[buttonIndex + 1]!));
  }
}

describe.each([
  { label: "single terminal", terminalIds: ["terminal-1"] },
  { label: "multiple terminals", terminalIds: ["terminal-1", "terminal-2"] },
])("terminal layout toolbar with $label", ({ terminalIds }) => {
  it.each([false, true])(
    "renders a muted bottom maximize/restore action, expanded=%s",
    (fillAvailableSpace) => {
      const markup = renderToStaticMarkup(
        <ThreadTerminalDrawer
          {...baseProps}
          terminalIds={terminalIds}
          fillAvailableSpace={fillAvailableSpace}
        />,
      );
      const label = fillAvailableSpace ? "Restore split view" : "Expand terminal";
      expect(markup).toContain(`aria-label="${label}"`);
      expectToolbar(markup, [
        "New Terminal",
        "Split Terminal",
        "Rename Terminal",
        "Close Terminal",
        label,
      ]);
    },
  );

  it("shares muted right-panel actions without chat layout expansion", () => {
    const markup = renderToStaticMarkup(
      <ThreadTerminalDrawer {...baseProps} mode="panel" terminalIds={terminalIds} />,
    );
    expect(markup).not.toContain('aria-label="Expand terminal"');
    expect(markup).not.toContain('aria-label="Restore split view"');
    expectToolbar(markup, ["New Terminal", "Split Terminal", "Rename Terminal", "Close Terminal"]);
  });
});
