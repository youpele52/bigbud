import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useOpencodeV2RetainedHistory } from "./useOpencodeV2RetainedHistory";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getOpencodeV2ThreadToolsSetup: mocks.get } }),
}));

function RetainedHistoryHarness({ threadId }: { threadId?: ThreadId }) {
  const message = useOpencodeV2RetainedHistory(threadId, "/workspace", "unchanged");
  return <p role="status">{message ?? "No retained warning"}</p>;
}

it("handles an absent thread and projects local read-only history without refreshing native setup", async () => {
  const screen = await render(<RetainedHistoryHarness />);
  try {
    await expect.element(screen.getByRole("status")).toHaveTextContent("No retained warning");
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({
      status: "incompatible-history",
      message: "Original isolated history is read-only.",
    });
    const threadId = ThreadId.makeUnsafe("retained-history");
    await screen.rerender(<RetainedHistoryHarness threadId={threadId} />);
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Original isolated history is read-only.");
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith({
      threadId,
      directory: "/workspace",
      refresh: false,
    });
    await screen.rerender(<RetainedHistoryHarness />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("No retained warning");
  } finally {
    await screen.unmount();
    mocks.get.mockReset();
  }
});
