import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ComponentProps } from "react";
import { normalizeTerminalSplitLayout, splitTerminalLayout } from "../../lib/terminalSplitLayout";
import { ThreadTerminalDrawerViewport } from "./ThreadTerminalDrawerViewport";

vi.mock("./TerminalViewport", () => ({
  TerminalViewport: ({ terminalId }: { terminalId: string }) => (
    <textarea data-pane={terminalId} aria-label={terminalId} />
  ),
}));

it("renders a downward split within the right pane and preserves the left pane", async () => {
  const layout = splitTerminalLayout(
    normalizeTerminalSplitLayout(undefined, ["a", "b"]),
    "b",
    "c",
    "down",
  );
  const props: ComponentProps<typeof ThreadTerminalDrawerViewport> = {
    threadId: "thread" as never,
    executionTargetId: undefined,
    cwd: "/repo",
    worktreePath: null,
    runtimeEnv: undefined,
    visible: true,
    visibleTerminalIds: ["a", "b", "c"],
    splitLayout: layout,
    resolvedActiveTerminalId: "c",
    terminalLabelById: new Map(),
    focusRequestId: 0,
    resizeEpoch: 0,
    drawerHeight: 400,
    keybindings: [],
    onActiveTerminalChange: vi.fn(),
    onCloseTerminal: vi.fn(),
    onAddTerminalContext: vi.fn(),
  };
  const screen = await render(
    <div style={{ width: 800, height: 400 }}>
      <ThreadTerminalDrawerViewport {...props} />
    </div>,
  );
  try {
    const bounds = (id: string) =>
      screen.container
        .querySelector(`[data-pane="${id}"]`)!
        .parentElement!.parentElement!.getBoundingClientRect();
    const a = bounds("a"),
      b = bounds("b"),
      c = bounds("c");
    expect(a.width).toBeCloseTo(400);
    expect(a.height).toBeCloseTo(400);
    expect(b.height).toBeCloseTo(200);
    expect(c.top).toBeCloseTo(b.bottom);
    expect(c.left).toBeCloseTo(b.left);
    expect(b.left).toBeCloseTo(a.right);
    (screen.getByRole("textbox", { name: "b", exact: true }).element() as HTMLElement).focus();
    expect(props.onActiveTerminalChange).toHaveBeenCalledWith("b");
  } finally {
    await screen.unmount();
  }
});

it("does not pass a pointer event as the toolbar split direction", async () => {
  const { default: Drawer } = await import("./ThreadTerminalDrawer");
  const split = vi.fn();
  const screen = await render(
    <div style={{ width: 800, height: 400 }}>
      <Drawer
        threadId={"thread" as never}
        cwd="/repo"
        height={400}
        terminalIds={["a", "b", "c"]}
        activeTerminalId="c"
        terminalGroups={[
          {
            id: "group",
            terminalIds: ["a", "b", "c"],
            layout: splitTerminalLayout(
              normalizeTerminalSplitLayout(undefined, ["a", "b"]),
              "b",
              "c",
              "down",
            ),
          },
        ]}
        activeTerminalGroupId="group"
        focusRequestId={0}
        keybindings={[]}
        terminalBaseLabel="Terminal"
        terminalLabelOverrides={{}}
        terminalProviderById={{}}
        onSplitTerminal={split}
        onNewTerminal={vi.fn()}
        onActiveTerminalChange={vi.fn()}
        onCloseTerminal={vi.fn()}
        onHeightChange={vi.fn()}
        onAddTerminalContext={vi.fn()}
        onSetTerminalLabelOverride={vi.fn()}
        onClearTerminalLabelOverride={vi.fn()}
        mode="panel"
      />
    </div>,
  );
  try {
    await screen.getByRole("button", { name: "Split Terminal", exact: true }).click();
    expect(split).toHaveBeenCalledExactlyOnceWith(undefined);
  } finally {
    await screen.unmount();
  }
});
