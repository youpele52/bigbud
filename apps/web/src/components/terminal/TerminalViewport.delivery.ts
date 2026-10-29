import type { Terminal } from "@xterm/xterm";
import type {
  TerminalDropPathMode,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher, type TerminalWriteBatcherOptions } from "./TerminalWriteBatcher";
import { makeApplyTerminalEvent } from "./TerminalViewport.events";
import { withTerminalViewDeadline } from "./terminalLifecycle.operations";
import { isCurrentTerminalSnapshot } from "../../lib/terminalLaunchBinding";
import {
  hasCurrentTerminalBaseline,
  resolveTerminalViewportSnapshot,
} from "./TerminalViewport.snapshot";

/** Reattach only the view; a failed replacement must never enable input or reopen a shell. */
export async function refreshTerminalViewportDelivery(
  snapshot: TerminalSessionSnapshot,
  input: {
    disposed: () => boolean;
    readDelivery: () => ReturnType<typeof createTerminalViewportDelivery>;
    replaceDelivery: () => ReturnType<typeof createTerminalViewportDelivery>;
    subscribe: () => void | Promise<void>;
    refreshSnapshot?: (() => Promise<TerminalSessionSnapshot>) | undefined;
    onSnapshot?: ((snapshot: TerminalSessionSnapshot) => void) | undefined;
  },
): Promise<void> {
  if (input.disposed()) return;
  let delivery = input.readDelivery();
  try {
    const current = await resolveTerminalViewportSnapshot(snapshot, {
      localUpdatedAt: () => delivery.intake.snapshotUpdatedAt,
      disposed: () => input.disposed() || input.readDelivery() !== delivery,
      refresh: input.refreshSnapshot,
    });
    if (!current || input.disposed() || input.readDelivery() !== delivery) return;
    if (
      !isCurrentTerminalSnapshot(current) &&
      !hasCurrentTerminalBaseline(current, delivery.intake.snapshotUpdatedAt)
    )
      throw new Error(
        "Terminal changed while reconnecting. Reload the view to fetch current output.",
      );
    input.onSnapshot?.(current);
    if (current.status !== "running" || current.pid === null) {
      delivery.intake.pause(
        new Error(
          "Terminal restart failed. Previous output was retained. Check the target and shell configuration, then retry.",
        ),
      );
      return;
    }
    if (delivery.writeBatcher.isStopped) delivery = input.replaceDelivery();
    await withTerminalViewDeadline(Promise.resolve(input.subscribe()));
    if (!input.disposed() && input.readDelivery() === delivery)
      await withTerminalViewDeadline(delivery.intake.hydrate(current));
  } catch (cause) {
    if (!input.disposed() && input.readDelivery() === delivery)
      delivery.intake.pause(
        cause instanceof Error ? cause : new Error("Terminal view recovery failed"),
      );
  }
}

/** Replace only a failed view's delivery lane; emulator and PTY ownership stay unchanged. */
export function createTerminalViewportDelivery(input: {
  terminalRef: { current: Terminal | null };
  hasHandledExitRef: { current: boolean };
  dropPathModeRef: { current: TerminalDropPathMode };
  clearSelectionAction: () => void;
  handleSessionExited: () => void;
  onInputState: (enabled: boolean) => void;
  onFailure: (error: Error) => void;
  onSnapshot?: (snapshot: TerminalSessionSnapshot) => boolean | void;
  /** Parked hydration output was settled by a snapshot without being parsed. */
  onCreditReleased?: () => void;
  /** Sees every output chunk the view receives (frame metrics); must not retain the text. */
  observeOutput?: (data: string) => void;
  batcherOptions?: TerminalWriteBatcherOptions;
}) {
  let disposed = false;
  const terminal = input.terminalRef.current!;
  const writeBatcher = new TerminalWriteBatcher((error) => {
    if (disposed) return;
    terminal.options.disableStdin = true;
    input.onInputState(false);
    input.onFailure(error);
  }, input.batcherOptions);
  const applyEvent = makeApplyTerminalEvent({
    ...input,
    writeBatcher,
    replaySnapshot: (snapshot) => {
      if (input.onSnapshot?.(snapshot) === false) return;
      intake.replay(snapshot);
    },
    isDisposed: () => disposed,
  });
  const observeOutput = input.observeOutput;
  const apply: typeof applyEvent = observeOutput
    ? (event) => {
        if (event.type === "output") observeOutput(event.data);
        applyEvent(event);
      }
    : applyEvent;
  const intake = new TerminalViewportIntake(
    terminal,
    writeBatcher,
    apply,
    (enabled) => {
      if (!disposed) input.onInputState(enabled);
    },
    () => {
      if (!disposed) input.onCreditReleased?.();
    },
    isCurrentTerminalSnapshot,
  );
  return {
    intake,
    writeBatcher,
    dispose() {
      disposed = true;
      intake.dispose();
      writeBatcher.dispose();
    },
  };
}
