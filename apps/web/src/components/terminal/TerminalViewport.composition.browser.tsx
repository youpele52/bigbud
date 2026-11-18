import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";
import { attachTerminalViewportInput } from "./TerminalViewport.input";

function fixture() {
  const container = document.createElement("div");
  container.style.cssText = "width:640px;height:320px";
  document.body.append(container);
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminal.open(container);
  terminal.focus();
  const write = vi.fn(async (_request: { data: string }) => {});
  const attached = attachTerminalViewportInput({
    terminal,
    terminalRef: { current: terminal },
    threadId: "composition-browser",
    terminalId: "one",
    keybindingsRef: { current: DEFAULT_BINDINGS },
    api: { terminal: { write } } as unknown as NativeApi,
    acceptsInput: () => true,
    markInput: vi.fn(),
    writeNotice: vi.fn(),
    tuiWheelMultiplier: () => 1,
    onFind: vi.fn(),
  });
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  return {
    textarea,
    write,
    dispose() {
      attached.dispose();
      terminal.dispose();
      container.remove();
    },
  };
}

// Real Chromium + installed xterm, but synthetic DOM composition, not an OS IME
// or a qualified suggestion barrier. No shell adapter is enabled by these tests.
describe("terminal browser composition baseline (not G1/G2)", () => {
  it("commits synthetic composition text once through the existing ordered input lane", async () => {
    const f = fixture();
    try {
      f.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      f.textarea.value = "日本語";
      f.textarea.dispatchEvent(
        new CompositionEvent("compositionupdate", { data: "日本語", bubbles: true }),
      );
      f.textarea.dispatchEvent(
        new InputEvent("input", {
          data: "日本語",
          inputType: "insertCompositionText",
          isComposing: true,
          bubbles: true,
        }),
      );
      expect(f.write).not.toHaveBeenCalled();
      f.textarea.dispatchEvent(
        new CompositionEvent("compositionend", { data: "日本語", bubbles: true }),
      );
      await expect
        .poll(() => f.write.mock.calls.map(([request]) => request.data).join(""))
        .toBe("日本語");
      expect(f.write).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
    }
  });

  it.each(["Tab", "ArrowRight", "Enter"])(
    "does not emit a synthetic composing %s as terminal acceptance input",
    async (key) => {
      const f = fixture();
      try {
        f.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        const event = new KeyboardEvent("keydown", {
          key,
          code: key,
          keyCode: 229,
          isComposing: true,
          shiftKey: key === "Enter",
          bubbles: true,
          cancelable: true,
        });
        f.textarea.dispatchEvent(event);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        expect(f.write).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      } finally {
        f.dispose();
      }
    },
  );
});
