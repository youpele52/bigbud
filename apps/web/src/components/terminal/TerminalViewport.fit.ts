import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

interface FitTerminalViewportInput {
  container: Pick<HTMLDivElement, "getBoundingClientRect"> | null;
  terminal: Pick<Terminal, "buffer" | "scrollToBottom"> | null;
  fitAddon: Pick<FitAddon, "fit"> | null;
  requestTerminalResize: () => void;
}

export function fitTerminalViewport(input: FitTerminalViewportInput): void {
  const { container, terminal, fitAddon, requestTerminalResize } = input;
  if (!terminal || !fitAddon || !container) return;
  const { width, height } = container.getBoundingClientRect();
  if (width < 32 || height < 32) return;
  const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  fitAddon.fit();
  if (wasAtBottom) terminal.scrollToBottom();
  requestTerminalResize();
}
