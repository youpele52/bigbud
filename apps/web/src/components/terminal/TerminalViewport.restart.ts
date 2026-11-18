import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { readNativeApi } from "../../rpc/nativeApi";
import { recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import {
  beginTerminalLifecycle,
  finishTerminalLifecycle,
  readTerminalLifecycle,
  updateTerminalLifecycle,
} from "../../stores/terminal/terminalLifecycle.store";
import {
  withTerminalLifecycleDeadline,
  withTerminalViewDeadline,
} from "./terminalLifecycle.operations";
import {
  recoverStaleTerminalLifecycle,
  refreshTerminalLifecycleViews,
} from "./terminalLifecycle.recovery";
import type { createTerminalViewportDelivery } from "./TerminalViewport.delivery";

import type { TerminalProfileReplacement } from "./TerminalProfilePicker.restart";
import { sameShellHost } from "../../lib/terminalProfileLaunch";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { toastManager } from "../ui/toast.manager";
import {
  isTerminalRestartNotStarted,
  restoreTerminalRestartDelivery,
} from "./TerminalViewport.restart.recovery";

type Delivery = ReturnType<typeof createTerminalViewportDelivery>;

/** Confirm intent, register delivery, then wait for the server's exit-confirmed replacement. */
export function makeTerminalRestartAction(input: {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  terminal: Terminal;
  readSnapshot: () => TerminalSessionSnapshot | null;
  disposed: () => boolean;
  prepare: (isCurrent: () => boolean) => Promise<Delivery | undefined>;
  isCurrent: (delivery: Delivery) => boolean;
  onSnapshot: (snapshot: TerminalSessionSnapshot) => void;
  onFailure: (error: Error) => void;
}) {
  return async (replacement?: TerminalProfileReplacement) => {
    if (input.disposed()) return;
    const previous = input.readSnapshot();
    if (!previous) return;
    const { threadId, terminalId } = previous;
    const retrying = readTerminalLifecycle(threadId, terminalId);
    if (retrying?.restartRequest && (replacement || retrying.restartRequest.shellSelection)) {
      input.onFailure(
        new Error(
          "A shell replacement is still unconfirmed. No additional launch was requested. Wait for the original operation to be confirmed.",
        ),
      );
      return;
    }
    const replacementCurrent = () =>
      !replacement ||
      (replacement.profile.shellSelection?.kind === "profile" &&
        !!replacement.profile.host &&
        replacement.isCurrent() &&
        previous.runtimeGeneration === replacement.expectedGeneration &&
        input.readSnapshot()?.runtimeGeneration === replacement.expectedGeneration &&
        (!previous.shellLaunchIdentity ||
          (!!replacement.profile.host &&
            sameShellHost(previous.shellLaunchIdentity.host, replacement.profile.host))));
    if (!replacementCurrent()) return;
    const operation = beginTerminalLifecycle(threadId, terminalId, "restart");
    if (!operation) return;
    let delivery: Delivery | undefined;
    let serverConfirmed = false;
    try {
      const confirmed = await input.api.dialogs.confirm(
        replacement
          ? "Replace this terminal's shell? This terminates its running shell and programs. Unsaved work may be lost. The selected profile will start in this terminal; this does not change the global default."
          : "Restart this terminal? This terminates its running shell and programs. Unsaved work in those programs may be lost. A fresh terminal will be started.",
      );
      if (!confirmed || input.disposed() || !replacementCurrent()) {
        if (retrying)
          updateTerminalLifecycle(threadId, terminalId, operation, {
            phase: "error",
            error: retrying.error,
          });
        else finishTerminalLifecycle(threadId, terminalId, operation);
        return;
      }
      const preparationCurrent = () =>
        !input.disposed() &&
        replacementCurrent() &&
        readTerminalLifecycle(threadId, terminalId)?.id === operation.id &&
        readTerminalLifecycle(threadId, terminalId)?.phase === "stopping";
      delivery = await withTerminalLifecycleDeadline(input.prepare(preparationCurrent));
      if (!delivery || !preparationCurrent() || !input.isCurrent(delivery)) {
        if (delivery && !input.disposed() && input.isCurrent(delivery))
          await restoreTerminalRestartDelivery(input, previous, delivery);
        finishTerminalLifecycle(threadId, terminalId, operation);
        return;
      }
      const host = replacement?.profile.host ?? previous.shellLaunchIdentity?.host;
      const target =
        host?.kind === "wsl" ? wslTerminalTargetId(host.distribution) : previous.executionTargetId;
      const request = operation.restartRequest ?? {
        threadId,
        terminalId,
        ...(replacement?.profile.shellSelection
          ? { shellSelection: replacement.profile.shellSelection }
          : previous.shellLaunchIdentity
            ? { shellSelection: previous.shellLaunchIdentity.selection }
            : {}),
        cwd: previous.cwd,
        worktreePath: previous.worktreePath,
        ...(previous.runtimeGeneration ? { expectedGeneration: previous.runtimeGeneration } : {}),
        operationId: operation.id,
        ...(target ? { executionTargetId: target } : {}),
        ...(previous.runtimeEnv ? { env: previous.runtimeEnv } : {}),
        cols: input.terminal.cols,
        rows: input.terminal.rows,
      };
      updateTerminalLifecycle(threadId, terminalId, operation, { restartRequest: request });
      const owner = delivery;
      await withTerminalLifecycleDeadline(
        input.api.terminal.restart(request).then(async (snapshot) => {
          if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
          serverConfirmed = true;
          const accepted = recordTerminalLaunch(snapshot);
          // Server outcome is definitive even if a renderer or subscription cannot recover.
          finishTerminalLifecycle(threadId, terminalId, operation);
          if (!accepted) {
            await refreshTerminalLifecycleViews(snapshot);
            return;
          }
          useTerminalStateStore.getState().hydrateTerminalAgentFromSnapshot(snapshot);
          const refresh = refreshTerminalLifecycleViews(snapshot);
          try {
            if (!input.disposed() && input.isCurrent(owner)) input.onSnapshot(snapshot);
            if (snapshot.status !== "running" || snapshot.pid === null) {
              throw new Error(
                "Terminal restart failed. Previous output was retained. Check the target and shell configuration, then retry.",
              );
            }
            if (!input.disposed() && input.isCurrent(owner)) {
              await withTerminalViewDeadline(owner.intake.hydrate(snapshot));
            }
          } catch (cause) {
            if (!input.disposed() && input.isCurrent(owner)) {
              const error =
                cause instanceof Error ? cause : new Error("Terminal view recovery failed");
              owner.intake.pause(error);
              input.onFailure(error);
            }
          }
          await refresh;
        }),
      );
    } catch (cause) {
      if (serverConfirmed || readTerminalLifecycle(threadId, terminalId)?.id !== operation.id)
        return;
      let failure = cause;
      try {
        if (operation.restartRequest && isTerminalRestartNotStarted(cause, previous)) {
          await restoreTerminalRestartDelivery(input, previous, delivery);
          if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
          finishTerminalLifecycle(threadId, terminalId, operation);
          toastManager.add({
            type: "error",
            title: "Terminal replacement was not started",
            description:
              cause instanceof Error ? cause.message : "The server refused this shell profile.",
          });
          return;
        }
        if (
          await recoverStaleTerminalLifecycle({
            error: cause,
            threadId,
            terminalId,
            operation,
            refresh: () =>
              withTerminalLifecycleDeadline(input.api.terminal.snapshot!({ threadId, terminalId })),
            onSnapshot: async (snapshot) => {
              if (input.disposed() || (delivery && !input.isCurrent(delivery))) return;
              input.onSnapshot(snapshot);
              if (delivery) {
                if (snapshot.status === "running" && snapshot.pid !== null)
                  await delivery.intake.hydrate(snapshot);
                else
                  delivery.intake.pause(
                    new Error("Terminal is not running. Review its output before retrying."),
                  );
              }
            },
          })
        )
          return;
      } catch (refreshError) {
        failure = refreshError;
      }
      if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
      const error = failure instanceof Error ? failure : new Error("Terminal restart failed");
      if (operation.restartRequest)
        updateTerminalLifecycle(threadId, terminalId, operation, {
          phase: "error",
          error: error.message,
        });
      else finishTerminalLifecycle(threadId, terminalId, operation);
      if (input.disposed() || (delivery && !input.isCurrent(delivery))) return;
      if (delivery) delivery.intake.pause(error);
      input.onFailure(error);
    }
  };
}
