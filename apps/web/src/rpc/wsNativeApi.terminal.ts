import type { NativeApi } from "@bigbud/contracts";
import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalRpcClient } from "./wsRpcClient.terminal.types";

export function createNativeTerminalApi(terminal: TerminalRpcClient): NativeApi["terminal"] {
  return {
    remoteInventory: (input) => terminal.remoteInventory(input),
    remoteAttach: (input) =>
      terminal.remoteAttach({
        ...input,
        terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      }),
    remoteDetach: (input) =>
      terminal.remoteDetach({
        ...input,
        terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      }),
    remoteStop: (input) =>
      terminal.remoteStop({
        ...input,
        terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      }),

    shellProfiles: (input) => terminal.shellProfiles(input),
    wslDistributions: () => terminal.wslDistributions(),
    snapshot: (input) => terminal.snapshot(input as never),
    recovery: (input) => terminal.recovery(input),
    open: (input) => terminal.open(input as never),
    write: (input) => terminal.write(input as never),
    resize: (input) => terminal.resize(input as never),
    clear: (input) => terminal.clear(input as never),
    restart: (input) => terminal.restart(input as never),
    close: (input) => terminal.close(input as never),
    onEvent: (callback, options) => terminal.onEvent(callback, options),
    subscribeSession: (input, callback, options) =>
      terminal.subscribeSession(input as never, callback, options),
    ackOutput: (input) => terminal.ackOutput(input),
    search: (input) => terminal.search(input),
  };
}
