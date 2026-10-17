import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { toastManager } from "../ui/toast.manager";
import type { TerminalRendererState } from "./TerminalRendererController";

export interface TerminalViewportToastState {
  inputEnabled: boolean;
  deliveryError: string | null;
  rendering: TerminalRendererState;
  retryGpu: () => void;
  retryDelivery?: () => void;
  historyUnavailable?: boolean;
  restartDelivery?: () => void;
  gpuRequested: boolean;
  terminalLabel: string;
  visible: boolean;
  startupPending?: boolean;
  startupFailed?: boolean;
  directoryNotice?: string | null;
}

type ToastOptions = Parameters<typeof toastManager.add>[0];
type ToastLane = { id: string | null; key: string | null };

/** Own transition-only, thread-scoped toasts independently of terminal/PTY lifetime. */
export class TerminalViewportToasts {
  private readonly input: ToastLane = { id: null, key: null };
  private readonly gpu: ToastLane = { id: null, key: null };
  private readonly folder: ToastLane = { id: null, key: null };
  private latest: TerminalViewportToastState | null = null;
  private disposed = false;

  constructor(private readonly threadId: ThreadId) {}

  update(state: TerminalViewportToastState): void {
    if (this.disposed) return;
    this.latest = state;
    if (!state.visible) {
      this.close(this.input);
      this.input.key = null;
      this.close(this.gpu);
      this.close(this.folder);
      return;
    }
    if (state.inputEnabled) {
      this.close(this.input);
      this.input.key = null;
    } else {
      const description =
        state.deliveryError ??
        (state.startupPending
          ? "Resolving terminal folder..."
          : "Restoring legacy terminal history — input paused");
      this.show(this.input, `${state.terminalLabel}:${description}`, {
        type: state.deliveryError ? "error" : "loading",
        title: state.deliveryError
          ? `${state.terminalLabel}: ${state.startupFailed ? "terminal startup failed" : "terminal input paused"}`
          : `${state.terminalLabel}: ${state.startupPending ? "resolving terminal folder" : "restoring terminal history"}`,
        description:
          state.deliveryError &&
          state.retryDelivery &&
          !state.startupFailed &&
          !state.historyUnavailable
            ? `${description}\nReload uses retained legacy history, not an exact restore. The running process will not be restarted.`
            : description,
        timeout: 0,
        actionProps:
          state.deliveryError && state.historyUnavailable
            ? {
                children: "Restart terminal",
                onClick: () => {
                  if (this.latest?.visible && this.latest.historyUnavailable)
                    this.latest.restartDelivery?.();
                },
              }
            : state.deliveryError && state.retryDelivery
              ? {
                  children: state.startupFailed ? "Retry terminal startup" : "Reload legacy view",
                  onClick: () => {
                    if (this.latest?.visible && this.latest.deliveryError)
                      this.latest.retryDelivery?.();
                  },
                }
              : undefined,
      });
    }
    if (state.inputEnabled && state.directoryNotice) {
      this.show(this.folder, state.directoryNotice, {
        type: "warning",
        title: `${state.terminalLabel}: started in Home`,
        description: state.directoryNotice,
        timeout: 10000,
      });
    }

    const reason = state.rendering.reason;
    if (!state.gpuRequested) {
      this.close(this.gpu);
      this.gpu.key = null;
    } else if (state.rendering.mode === "webgl") {
      if (this.gpu.key !== null) {
        this.show(this.gpu, "webgl", {
          type: "success",
          title: `${state.terminalLabel}: GPU rendering restored`,
          description: "Terminal history and running processes were preserved.",
          timeout: 5000,
          actionProps: undefined,
        });
      }
    } else if (
      reason &&
      reason !== "Hidden terminal uses DOM." &&
      reason !== "Awaiting application rendering policy."
    ) {
      this.show(this.gpu, `${state.terminalLabel}:${reason}`, {
        type: "warning",
        title: `${state.terminalLabel}: using DOM rendering`,
        description: reason,
        timeout: 10000,
        actionProps: {
          children: "Retry GPU",
          onClick: () => {
            if (this.latest?.visible && this.latest.gpuRequested) this.latest.retryGpu();
          },
        },
      });
    }
  }

  private show(lane: ToastLane, key: string, options: ToastOptions): void {
    if (lane.key === key) return;
    lane.key = key;
    const toast = { ...options, data: { threadId: this.threadId } };
    if (lane.id !== null) {
      toastManager.update(lane.id, toast);
    } else {
      const id = toastManager.add({
        ...toast,
        onClose: () => {
          if (lane.id === id) lane.id = null;
        },
      });
      lane.id = id;
    }
  }

  private close(lane: ToastLane): void {
    const id = lane.id;
    lane.id = null;
    if (id !== null) toastManager.close(id);
  }

  dispose(): void {
    this.disposed = true;
    this.latest = null;
    this.close(this.input);
    this.close(this.gpu);
    this.close(this.folder);
  }
}
