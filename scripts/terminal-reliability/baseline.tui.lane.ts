// Browser entry bundled by baseline.tui.mjs: exposes bigbud's production write lane to the page.
import type { Terminal } from "@xterm/xterm";
import { TerminalWriteBatcher } from "../../apps/web/src/components/terminal/TerminalWriteBatcher";

interface BaselineLane {
  write(data: string): void;
  readonly failure: string | null;
}

declare global {
  interface Window {
    createBigbudLane?: (terminal: Terminal) => BaselineLane;
  }
}

window.createBigbudLane = (terminal) => {
  let failure: string | null = null;
  const batcher = new TerminalWriteBatcher((error) => {
    failure = error.message;
  });
  return {
    write: (data) => batcher.write(terminal, data),
    get failure() {
      return failure;
    },
  };
};
