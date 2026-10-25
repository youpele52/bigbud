import { useEffect, useEffectEvent, useRef, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { readNativeApi } from "../../rpc/nativeApi";

/** Coalesce geometry changes without letting old RPC completions mutate a replacement view. */
export function useTerminalResizeRequest(input: {
  terminalRef: MutableRefObject<Terminal | null>;
  threadId: ThreadId;
  terminalId: string;
}) {
  const stateRef = useRef<{ terminal: Terminal; inFlight: boolean; pending: boolean } | null>(null);
  useEffect(() => {
    stateRef.current = null;
  }, [input.threadId, input.terminalId]);
  const request = useEffectEvent(() => {
    const api = readNativeApi();
    const terminal = input.terminalRef.current;
    if (!api || !terminal) return;
    if (stateRef.current?.terminal !== terminal)
      stateRef.current = { terminal, inFlight: false, pending: false };
    const state = stateRef.current;
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    state.inFlight = true;
    state.pending = false;
    void api.terminal
      .resize({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .catch(() => undefined)
      .finally(() => {
        if (stateRef.current !== state || input.terminalRef.current !== terminal) return;
        state.inFlight = false;
        if (!state.pending) return;
        state.pending = false;
        request();
      });
  });
  return request;
}
