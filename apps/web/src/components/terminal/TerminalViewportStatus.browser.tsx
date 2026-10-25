import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { toastManager } from "../ui/toast.manager";
import { TerminalViewportStatus } from "./TerminalViewportStatus";

vi.mock("../ui/toast.manager", () => ({
  toastManager: { add: vi.fn(() => "terminal-status-toast"), update: vi.fn(), close: vi.fn() },
}));

it("renders no terminal overlay and owns progress toast lifecycle", async () => {
  const props = {
    threadId: ThreadId.makeUnsafe("terminal-status"),
    terminalId: "terminal-1",
    terminalLabel: "Terminal 1",
    visible: true,
    inputEnabled: false,
    deliveryError: null,
    rendering: { mode: "dom" as const, reason: null },
    retryGpu: vi.fn(),
    gpuRequested: true,
  };
  const screen = await render(<TerminalViewportStatus {...props} />);
  try {
    expect(screen.container.textContent).toBe("");
    expect(toastManager.add).toHaveBeenCalledOnce();
    await screen.rerender(<TerminalViewportStatus {...props} retryGpu={vi.fn()} />);
    expect(toastManager.add).toHaveBeenCalledOnce();
    await screen.rerender(<TerminalViewportStatus {...props} inputEnabled />);
    expect(toastManager.close).toHaveBeenCalledWith("terminal-status-toast");
    await screen.rerender(<TerminalViewportStatus {...props} />);
    expect(toastManager.add).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
  expect(toastManager.close).toHaveBeenCalledTimes(2);
});
