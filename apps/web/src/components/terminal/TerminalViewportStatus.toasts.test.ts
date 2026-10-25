import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toastManager } from "../ui/toast.manager";
import {
  TerminalViewportToasts,
  type TerminalViewportToastState,
} from "./TerminalViewportStatus.toasts";

vi.mock("../ui/toast.manager", () => ({
  toastManager: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));

const threadId = ThreadId.makeUnsafe("terminal-toast-thread");
function state(overrides: Partial<TerminalViewportToastState> = {}): TerminalViewportToastState {
  return {
    inputEnabled: true,
    deliveryError: null,
    rendering: { mode: "dom", reason: null },
    gpuRequested: true,
    retryGpu: vi.fn(),
    terminalLabel: "Terminal 1",
    visible: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  let nextId = 0;
  vi.mocked(toastManager.add).mockImplementation(() => `toast-${++nextId}`);
});

describe("terminal status toasts", () => {
  it("reports folder resolution and retries failed startup rather than a nonexistent legacy view", () => {
    const toasts = new TerminalViewportToasts(threadId);
    toasts.update(state({ inputEnabled: false, startupPending: true }));
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "loading", description: "Resolving terminal folder..." }),
    );
    const retryDelivery = vi.fn();
    toasts.update(
      state({
        inputEnabled: false,
        startupFailed: true,
        deliveryError: "Could not save the chat",
        retryDelivery,
      }),
    );
    const update = vi.mocked(toastManager.update).mock.calls.at(-1)?.[1];
    expect(update).toMatchObject({
      type: "error",
      title: "Terminal 1: terminal startup failed",
      description: "Could not save the chat",
      actionProps: { children: "Retry terminal startup" },
    });
    update?.actionProps?.onClick?.({} as never);
    expect(retryDelivery).toHaveBeenCalledOnce();
    toasts.dispose();
  });

  it("reports the actual Home folder and reason without changing a running terminal", () => {
    const toasts = new TerminalViewportToasts(threadId);
    toasts.update(state({ directoryNotice: "Missing /project. Started in /home/target." }));
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Terminal 1: started in Home",
        description: "Missing /project. Started in /home/target.",
      }),
    );
    toasts.dispose();
  });
  it("deduplicates restoration progress and closes it when input resumes", () => {
    const toasts = new TerminalViewportToasts(threadId);
    const paused = state({ inputEnabled: false });
    toasts.update(paused);
    toasts.update({ ...paused });
    expect(toastManager.add).toHaveBeenCalledOnce();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "loading",
        description: "Restoring legacy terminal history — input paused",
        timeout: 0,
        data: { threadId },
      }),
    );
    toasts.update(state());
    expect(toastManager.close).toHaveBeenCalledWith("toast-1");
    toasts.update(paused);
    expect(toastManager.add).toHaveBeenCalledTimes(2);
    toasts.dispose();
  });

  it("updates progress to an error without duplicating the toast", () => {
    const toasts = new TerminalViewportToasts(threadId);
    toasts.update(state({ inputEnabled: false }));
    toasts.update(state({ inputEnabled: false, deliveryError: "Terminal hydration overflowed" }));
    expect(toastManager.add).toHaveBeenCalledOnce();
    expect(toastManager.update).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({
        type: "error",
        description: "Terminal hydration overflowed",
        timeout: 0,
      }),
    );
    toasts.dispose();
  });

  it.each([null, "Hidden terminal uses DOM.", "Awaiting application rendering policy."])(
    "does not mistake transient DOM state %s for a GPU failure",
    (reason) => {
      const toasts = new TerminalViewportToasts(threadId);
      toasts.update(state({ rendering: { mode: "dom", reason } }));
      toasts.update(state({ rendering: { mode: "webgl", reason: null } }));
      expect(toastManager.add).not.toHaveBeenCalled();
      toasts.dispose();
    },
  );

  it("explains GPU fallback, uses the latest retry callback and reports recovery once", () => {
    const toasts = new TerminalViewportToasts(threadId);
    const fallback = state({
      rendering: { mode: "dom", reason: "WebGL context lost; terminal preserved in DOM." },
    });
    toasts.update(fallback);
    const nextRetry = vi.fn();
    toasts.update({ ...fallback, retryGpu: nextRetry });
    expect(toastManager.add).toHaveBeenCalledOnce();
    const options = vi.mocked(toastManager.add).mock.calls[0]![0];
    expect(options).toMatchObject({ type: "warning", description: fallback.rendering.reason });
    expect(options.actionProps?.children).toBe("Retry GPU");
    const retry = options.actionProps?.onClick;
    retry?.({} as never);
    expect(nextRetry).toHaveBeenCalledOnce();
    expect(fallback.retryGpu).not.toHaveBeenCalled();
    const recovered = state({ rendering: { mode: "webgl", reason: null } });
    toasts.update(recovered);
    toasts.update(recovered);
    expect(toastManager.update).toHaveBeenCalledOnce();
    expect(toastManager.update).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({
        type: "success",
        timeout: 5000,
        actionProps: undefined,
      }),
    );
    toasts.dispose();
    retry?.({} as never);
    expect(nextRetry).toHaveBeenCalledOnce();
  });

  it("does not resurrect dismissed toasts on ordinary rerenders", () => {
    const toasts = new TerminalViewportToasts(threadId);
    const paused = state({ inputEnabled: false });
    toasts.update(paused);
    vi.mocked(toastManager.add).mock.calls[0]![0].onClose?.();
    toasts.update(paused);
    expect(toastManager.add).toHaveBeenCalledOnce();
    toasts.update({ ...paused, deliveryError: "Delivery paused" });
    expect(toastManager.add).toHaveBeenCalledTimes(2);
    expect(toastManager.update).not.toHaveBeenCalled();
    toasts.dispose();
  });

  it("closes owned toasts when hidden, suppresses hidden notifications and cleans up on dispose", () => {
    const toasts = new TerminalViewportToasts(threadId);
    const paused = state({ inputEnabled: false });
    toasts.update(paused);
    toasts.update({ ...paused, visible: false });
    toasts.update({ ...paused, visible: false, deliveryError: "Hidden failure" });
    expect(toastManager.close).toHaveBeenCalledWith("toast-1");
    expect(toastManager.add).toHaveBeenCalledOnce();
    toasts.dispose();
    toasts.update(paused);
    expect(toastManager.add).toHaveBeenCalledOnce();
  });

  it("clears GPU notices when acceleration is turned off", () => {
    const toasts = new TerminalViewportToasts(threadId);
    toasts.update(state({ rendering: { mode: "dom", reason: "WebGL attachment failed" } }));
    toasts.update(state({ gpuRequested: false }));
    expect(toastManager.close).toHaveBeenCalledWith("toast-1");
    toasts.dispose();
  });
});
