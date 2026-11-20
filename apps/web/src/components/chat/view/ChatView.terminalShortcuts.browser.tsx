import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_BINDINGS } from "../../../models/keybindings/keybindings.models.test.helpers";
import { useChatKeybindings, type UseChatKeybindingsInput } from "./ChatView.keybindings.logic";

function Harness({ input }: { input: UseChatKeybindingsInput }) {
  useChatKeybindings(input);
  return (
    <div className="thread-terminal-drawer">
      <div className="xterm">
        <textarea className="xterm-helper-textarea" aria-label="Terminal" />
      </div>
      <input aria-label="Rename" />
      <textarea aria-label="Composer" />
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

it.each(["MacIntel", "Win32", "Linux"])(
  "splits, closes and creates terminals only with terminal focus on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const input: UseChatKeybindingsInput = {
      activeThreadId: "thread",
      activeProject: null,
      terminalState: { terminalOpen: true, activeTerminalId: "active-pane" },
      // Deliberately remove every configured condition: the action owner must still check focus.
      keybindings: DEFAULT_BINDINGS.filter((binding) =>
        binding.command.startsWith("terminal."),
      ).map(({ whenAst: _when, ...binding }) => binding),
      toggleTerminalVisibility: vi.fn(),
      toggleTerminalPanel: vi.fn(),
      setTerminalOpen: vi.fn(),
      splitTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      createNewTerminal: vi.fn(),
      onToggleDiff: vi.fn(),
      runProjectScript: vi.fn(),
    };
    const screen = await render(<Harness input={input} />);
    try {
      for (const label of ["Rename", "Composer", "Terminal"]) {
        (
          screen.getByRole("textbox", { name: label, exact: true }).element() as HTMLElement
        ).focus();
        for (const [key, action, shiftKey] of [
          ["d", input.splitTerminal, false],
          ["d", input.splitTerminal, true],
          ["w", input.closeTerminal, false],
          ["n", input.createNewTerminal, false],
        ] as const) {
          vi.mocked(action).mockClear();
          const event = new KeyboardEvent("keydown", {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
          });
          document.activeElement!.dispatchEvent(event);
          expect(action).toHaveBeenCalledTimes(label === "Terminal" ? 1 : 0);
          if (label === "Terminal") {
            expect(event.defaultPrevented).toBe(true);
            if (key === "d") expect(action).toHaveBeenLastCalledWith(shiftKey ? "down" : "right");
          }
        }
      }
      expect(input.closeTerminal).toHaveBeenLastCalledWith("active-pane");
    } finally {
      await screen.unmount();
    }
  },
);
