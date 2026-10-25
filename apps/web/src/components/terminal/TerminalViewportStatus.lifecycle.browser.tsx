import "../../index.css";
import { StrictMode } from "react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ToastProvider, toastManager } from "../ui/toast";
import { TerminalViewportStatus } from "./TerminalViewportStatus";

vi.mock("@tanstack/react-router", () => ({ useParams: () => "lifecycle" }));
const props = {
  threadId: ThreadId.makeUnsafe("lifecycle"),
  terminalId: "one",
  terminalLabel: "Chats",
  inputEnabled: false,
  deliveryError: null,
  visible: true,
  rendering: { mode: "dom" as const, reason: null },
  gpuRequested: false,
  retryGpu: () => undefined,
};

it("removes progress through StrictMode cleanup and rapid completion", async () => {
  const added = vi.spyOn(toastManager, "add");
  const closed = vi.spyOn(toastManager, "close");
  const provider = await render(<ToastProvider />);
  const screen = await render(
    <StrictMode>
      <TerminalViewportStatus {...props} />
    </StrictMode>,
  );
  try {
    await screen.rerender(
      <StrictMode>
        <TerminalViewportStatus {...props} inputEnabled />
      </StrictMode>,
    );
    expect(added).toHaveBeenCalledTimes(2);
    expect(closed.mock.calls.map(([id]) => id)).toEqual(
      added.mock.results.map(({ value }) => value),
    );
    await expect
      .poll(() => document.querySelectorAll('[data-slot="toast-title"]').length, { timeout: 5000 })
      .toBe(0);
  } finally {
    await screen.unmount();
    toastManager.close();
    await provider.unmount();
    added.mockRestore();
    closed.mockRestore();
  }
});

it("retires hidden and replaced terminal owners without resurrecting their progress", async () => {
  const provider = await render(<ToastProvider />);
  const screen = await render(<TerminalViewportStatus {...props} />);
  try {
    await expect.element(provider.getByText("Chats: restoring terminal history")).toBeVisible();
    await screen.rerender(<TerminalViewportStatus {...props} visible={false} />);
    await expect
      .element(provider.getByText("Chats: restoring terminal history"))
      .not.toBeInTheDocument();
    await screen.rerender(<TerminalViewportStatus {...props} visible={false} inputEnabled />);
    await screen.rerender(<TerminalViewportStatus {...props} inputEnabled />);
    await expect
      .element(provider.getByText("Chats: restoring terminal history"))
      .not.toBeInTheDocument();
    await screen.rerender(<TerminalViewportStatus {...props} terminalId="replacement" />);
    await expect.element(provider.getByText("Chats: restoring terminal history")).toBeVisible();
    await screen.rerender(
      <TerminalViewportStatus {...props} terminalId="replacement" inputEnabled />,
    );
    await expect
      .element(provider.getByText("Chats: restoring terminal history"))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    toastManager.close();
    await provider.unmount();
  }
});
