import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";
import {
  useChatKeybindings,
  type UseChatKeybindingsInput,
} from "../chat/view/ChatView.keybindings.logic";
import { useTerminalSurfaceShortcuts } from "./useTerminalSurfaceShortcuts";

const press = (key: string, shiftKey = false) => {
  const mac = /mac/i.test(navigator.platform);
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    }),
  );
};

it("routes editing to the focused surface while preserving global toggles", async () => {
  const drawer = { split: vi.fn(), create: vi.fn(), close: vi.fn() };
  const panel = { split: vi.fn(), create: vi.fn(), close: vi.fn() };
  const fallback: UseChatKeybindingsInput = {
    activeThreadId: "thread",
    activeProject: null,
    terminalState: { terminalOpen: true, activeTerminalId: "wrong-pane" },
    keybindings: DEFAULT_BINDINGS,
    toggleTerminalVisibility: vi.fn(),
    toggleTerminalPanel: vi.fn(),
    setTerminalOpen: vi.fn(),
    splitTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    createNewTerminal: vi.fn(),
    onToggleDiff: vi.fn(),
    runProjectScript: vi.fn(),
  };
  function Surface({ mode, actions }: { mode: string; actions: typeof panel }) {
    const surface = useRef<HTMLElement | null>(null);
    useTerminalSurfaceShortcuts({
      surface,
      keybindings: DEFAULT_BINDINGS,
      activeTerminalId: mode,
      ...actions,
    });
    return (
      <aside ref={surface} data-terminal-surface={mode}>
        <div className="xterm">
          <textarea className="xterm-helper-textarea" aria-label={mode} />
        </div>
      </aside>
    );
  }
  function Harness() {
    useChatKeybindings(fallback);
    return (
      <>
        <Surface mode="drawer" actions={drawer} />
        <Surface mode="panel" actions={panel} />
        <input aria-label="Composer" />
      </>
    );
  }
  const screen = await render(<Harness />);
  try {
    for (const [mode, actions, other] of [
      ["drawer", drawer, panel],
      ["panel", panel, drawer],
    ] as const) {
      vi.clearAllMocks();
      (screen.getByRole("textbox", { name: mode, exact: true }).element() as HTMLElement).focus();
      press("d");
      press("d", true);
      press("n");
      press("w");
      expect(actions.split).toHaveBeenNthCalledWith(1, "right");
      expect(actions.split).toHaveBeenNthCalledWith(2, "down");
      expect(actions.create).toHaveBeenCalledOnce();
      expect(actions.close).toHaveBeenCalledExactlyOnceWith(mode);
      expect(other.split).not.toHaveBeenCalled();
      expect(other.close).not.toHaveBeenCalled();
      expect(fallback.splitTerminal).not.toHaveBeenCalled();
      expect(fallback.closeTerminal).not.toHaveBeenCalled();
    }
    (
      screen.getByRole("textbox", { name: "Composer", exact: true }).element() as HTMLElement
    ).focus();
    press("j");
    press("j", true);
    expect(fallback.toggleTerminalVisibility).toHaveBeenCalledOnce();
    expect(fallback.toggleTerminalPanel).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
