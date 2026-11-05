import type { FitAddon } from "@xterm/addon-fit";
import { preserveTerminalScroll, type TerminalScrollTarget } from "./terminalScrollState";
import { deferRecoveryFit } from "./terminalRecoveryGeometry";

interface FitTerminalViewportInput {
  container: Pick<HTMLDivElement, "getBoundingClientRect"> | null;
  terminal: TerminalScrollTarget | null;
  fitAddon: (Pick<FitAddon, "fit"> & Partial<Pick<FitAddon, "proposeDimensions">>) | null;
  requestTerminalResize: () => void;
}

export function fitTerminalViewport(input: FitTerminalViewportInput): void {
  const { container, terminal, fitAddon, requestTerminalResize } = input;
  if (!terminal || !fitAddon || !container) return;
  const { width, height } = container.getBoundingClientRect();
  if (width < 32 || height < 32) return;
  if (!deferRecoveryFit(terminal, fitAddon)) preserveTerminalScroll(terminal, () => fitAddon.fit());
  requestTerminalResize();
}
