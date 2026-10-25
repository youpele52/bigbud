import { useRef } from "react";
import { bindTerminalLaunch, type TerminalLaunchBinding } from "../../lib/terminalLaunchBinding";

/** Keep live props from mutating a mounted terminal, while allowing viewport identity reuse. */
export function useTerminalLaunchBinding(
  threadId: string,
  terminalId: string,
  context: TerminalLaunchBinding,
): TerminalLaunchBinding {
  const ref = useRef<{
    threadId: string;
    terminalId: string;
    context: TerminalLaunchBinding;
  } | null>(null);
  if (!ref.current || ref.current.threadId !== threadId || ref.current.terminalId !== terminalId) {
    ref.current = {
      threadId,
      terminalId,
      context: bindTerminalLaunch(threadId, terminalId, context),
    };
  }
  return ref.current.context;
}
