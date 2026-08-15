import { ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../../rpc/nativeApi";
import { ThreadErrorBanner } from "../common/ThreadErrorBanner";
import { usePromptQueue } from "./ChatView.promptQueue.logic";

const threadId = ThreadId.makeUnsafe("thread-prompt-queue-errors");
const projectedPrompts = [
  { id: "prompt-1", text: "Projected prompt", createdAt: "2026-08-01T00:00:00.000Z" },
];

function Harness(props: {
  onError: (message: string) => void;
  active?: boolean;
  onInterrupt?: (options?: { queuedPromptIdsAfterSettlement?: readonly string[] }) => Promise<void>;
}) {
  const queue = usePromptQueue({
    threadId,
    projectedPrompts,
    activeTurnInProgress: props.active === true,
    onInterrupt: props.onInterrupt ?? (async () => {}),
    onError: props.onError,
    newId: () => "prompt-new",
  });
  return (
    <>
      <output>{queue.queuedPrompts.map((prompt) => prompt.text).join(",")}</output>
      <button onClick={() => queue.queuePrompt("Queued")}>Queue</button>
      <button onClick={() => queue.removeQueuedPrompt("prompt-1")}>Remove</button>
      <button onClick={() => void queue.interruptAndFlushQueuedPrompts()}>Send now</button>
    </>
  );
}

function RenderedErrorHarness() {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ThreadErrorBanner error={error} onDismiss={() => setError(null)} />
      <Harness onError={setError} />
    </>
  );
}

describe("usePromptQueue command rejection", () => {
  afterEach(() => {
    delete window.nativeApi;
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("reports queue, remove, and flush rejection without mutating projection", async () => {
    const dispatchCommand = vi.fn(async () => {
      throw new Error("Queue command rejected");
    });
    window.nativeApi = { orchestration: { dispatchCommand } } as never;
    __resetNativeApiForTests();
    const onError = vi.fn();
    await render(<Harness onError={onError} />);

    for (const label of ["Queue", "Remove", "Send now"]) {
      await page.getByRole("button", { name: label }).click();
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Queue command rejected"));
      expect(document.querySelector("output")?.textContent).toBe("Projected prompt");
      onError.mockClear();
    }
    expect(dispatchCommand).toHaveBeenCalledTimes(3);
  });

  it("dispatches the routine text follow-up with authoritative auto delivery", async () => {
    const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
    window.nativeApi = { orchestration: { dispatchCommand } } as never;
    __resetNativeApiForTests();
    await render(<Harness onError={() => {}} />);

    await page.getByRole("button", { name: "Queue" }).click();
    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.message.submit", delivery: "auto" }),
    );
  });

  it("renders a rejection through the established ChatView error surface", async () => {
    window.nativeApi = {
      orchestration: {
        dispatchCommand: vi.fn(async () => {
          throw new Error("Queue command rejected");
        }),
      },
    } as never;
    __resetNativeApiForTests();
    await render(<RenderedErrorHarness />);

    await page.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() => {
      expect(page.getByRole("alert")).toHaveTextContent("Queue command rejected");
    });
    expect(document.querySelector("output")?.textContent).toBe("Projected prompt");
  });

  it("renders projection after remount and dispatches remove and idle Send now", async () => {
    const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
    window.nativeApi = { orchestration: { dispatchCommand } } as never;
    __resetNativeApiForTests();
    const first = await render(<Harness onError={() => {}} />);
    expect(document.querySelector("output")?.textContent).toBe("Projected prompt");
    await first.unmount();

    await render(<Harness onError={() => {}} />);
    expect(document.querySelector("output")?.textContent).toBe("Projected prompt");
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Send now" }).click();
    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(2));
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.queued-prompt.remove",
      messageId: "prompt-1",
    });
    expect(dispatchCommand.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.queued-prompt.flush",
      messageIds: ["prompt-1"],
    });
  });

  it("interrupts an active turn and leaves settlement to the server", async () => {
    const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
    window.nativeApi = { orchestration: { dispatchCommand } } as never;
    __resetNativeApiForTests();
    const onInterrupt = vi.fn(async () => {});
    await render(<Harness active onError={() => {}} onInterrupt={onInterrupt} />);
    await page.getByRole("button", { name: "Send now" }).click();
    await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());
    expect(onInterrupt).toHaveBeenCalledWith({ queuedPromptIdsAfterSettlement: ["prompt-1"] });
    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(document.querySelector("output")?.textContent).toBe("Projected prompt");
  });
});
