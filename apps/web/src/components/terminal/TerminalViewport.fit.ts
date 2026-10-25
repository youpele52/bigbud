import type { FitAddon } from "@xterm/addon-fit";
import { preserveTerminalScroll, type TerminalScrollTarget } from "./terminalScrollState";

interface FitTerminalViewportInput {
  container: Pick<HTMLDivElement, "getBoundingClientRect"> | null;
  terminal: TerminalScrollTarget | null;
  fitAddon: Pick<FitAddon, "fit"> | null;
  requestTerminalResize: () => void;
}

export function fitTerminalViewport(input: FitTerminalViewportInput): void {
  const { container, terminal, fitAddon, requestTerminalResize } = input;
  if (!terminal || !fitAddon || !container) return;
  const { width, height } = container.getBoundingClientRect();
  if (width < 32 || height < 32) return;
  preserveTerminalScroll(terminal, () => fitAddon.fit());
  requestTerminalResize();
}
