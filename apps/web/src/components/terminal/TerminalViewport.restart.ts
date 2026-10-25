import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { readNativeApi } from "../../rpc/nativeApi";
import { recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import type { createTerminalViewportDelivery } from "./TerminalViewport.delivery";

type Delivery = ReturnType<typeof createTerminalViewportDelivery>;

/** Restart only after confirmation, installing a new delivery lane before lifecycle events arrive. */
export function makeTerminalRestartAction(input: {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  terminal: Terminal;
  readSnapshot: () => TerminalSessionSnapshot | null;
  disposed: () => boolean;
  /** Installs the new lane and resolves once its stream is registered with the server. */
  prepare: () => Promise<Delivery>;
  isCurrent: (delivery: Delivery) => boolean;
  onSnapshot: (snapshot: TerminalSessionSnapshot) => void;
  onFailure: (error: Error) => void;
}) {
  let busy = false;
  return async () => {
    if (busy || input.disposed()) return;
    const previous = input.readSnapshot();
    if (!previous) return;
    busy = true;
    let delivery: Delivery | undefined;
    try {
      const confirmed = await input.api.dialogs.confirm(
        "Restart this terminal? This terminates its running shell and programs. Unsaved work in those programs may be lost. A fresh terminal will be started.",
      );
      if (!confirmed || input.disposed()) return;
      delivery = await input.prepare();
      if (input.disposed() || !input.isCurrent(delivery)) return;
      const snapshot = await input.api.terminal.restart({
        threadId: previous.threadId,
        terminalId: previous.terminalId,
        cwd: previous.cwd,
        worktreePath: previous.worktreePath,
        ...(previous.executionTargetId ? { executionTargetId: previous.executionTargetId } : {}),
        ...(previous.runtimeEnv ? { env: previous.runtimeEnv } : {}),
        cols: input.terminal.cols,
        rows: input.terminal.rows,
      });
      if (input.disposed() || !input.isCurrent(delivery)) return;
      input.onSnapshot(snapshot);
      if (snapshot.status !== "running" || snapshot.pid === null) {
        throw new Error(
          "Terminal restart failed. Check the target and shell configuration, then retry.",
        );
      }
      recordTerminalLaunch(snapshot);
      useTerminalStateStore.getState().hydrateTerminalAgentFromSnapshot(snapshot);
      await delivery.intake.hydrate(snapshot);
    } catch (cause) {
      if (input.disposed() || (delivery && !input.isCurrent(delivery))) return;
      const error = cause instanceof Error ? cause : new Error("Terminal restart failed");
      if (delivery) delivery.intake.pause(error);
      input.onFailure(error);
    } finally {
      busy = false;
    }
  };
}
