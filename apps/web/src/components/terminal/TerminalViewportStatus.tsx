import { useEffect, useRef } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  TerminalViewportToasts,
  type TerminalViewportToastState,
} from "./TerminalViewportStatus.toasts";

/** Report terminal transitions without covering the prompt or terminal output. */
export function TerminalViewportStatus(
  input: TerminalViewportToastState & {
    threadId: ThreadId;
    terminalId: string;
  },
) {
  const toastsRef = useRef<TerminalViewportToasts | null>(null);
  useEffect(() => {
    const toasts = new TerminalViewportToasts(input.threadId);
    toastsRef.current = toasts;
    return () => {
      toasts.dispose();
      toastsRef.current = null;
    };
  }, [input.threadId, input.terminalId]);
  useEffect(() => {
    toastsRef.current?.update(input);
  }, [input]);
  return null;
}
