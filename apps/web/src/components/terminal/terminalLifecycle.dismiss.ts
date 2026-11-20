import { ThreadId } from "@bigbud/contracts";
import { randomUUID } from "../../lib/utils";
import { readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { dismissTerminalPaneInState } from "../../stores/terminal/terminal.store.dismiss";
import {
  finishTerminalLifecycle,
  readTerminalLifecycle,
} from "../../stores/terminal/terminalLifecycle.store";

/** Dismiss only an explicitly refused direct close; no process or ownership operation. */
export function dismissUnconfirmedTerminalPane(threadId: string, terminalId: string): void {
  const operation = readTerminalLifecycle(threadId, terminalId);
  if (!operation?.canDismiss || operation.kind !== "close" || operation.phase !== "error") return;
  const generation = readTerminalLaunch(threadId, terminalId)?.runtimeGeneration;
  if (generation && operation.expectedGeneration && generation !== operation.expectedGeneration)
    return;
  useTerminalStateStore.setState((state) =>
    dismissTerminalPaneInState(
      state,
      ThreadId.makeUnsafe(threadId),
      terminalId,
      `terminal-${randomUUID()}`,
    ),
  );
  finishTerminalLifecycle(threadId, terminalId, operation);
}
