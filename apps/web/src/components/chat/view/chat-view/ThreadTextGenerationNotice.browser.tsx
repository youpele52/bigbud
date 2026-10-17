import "../../../../index.css";
import { EventId, ThreadId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadTextGenerationNotice } from "./ThreadTextGenerationNotice";

const mocks = vi.hoisted(() => ({ retry: vi.fn(() => Promise.resolve()) }));
vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => ({ server: { retryTextGeneration: mocks.retry } }),
}));
const threadId = ThreadId.makeUnsafe("thread-fixture");
const status = (kind: "failed" | "completed" | "retry-requested"): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(`fixture:${kind}`),
  kind: `text-generation.${kind}`,
  tone: "info",
  summary: "Couldn’t generate thread title. You can retry without resending your message.",
  payload: { operation: "title" },
  turnId: null,
  createdAt: "2026-10-16T00:00:00.000Z",
});

describe("thread generation warning", () => {
  it("does not resurrect a completed warning for a coalesced late retry request", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[status("failed"), status("completed"), status("retry-requested")]}
      />,
    );
    expect(document.querySelector("[role=status]")).toBeNull();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });
  it("shows a nonblocking warning with a metadata-only Retry action", async () => {
    await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={[status("failed")]} />,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Couldn’t generate thread title");
    await page.getByRole("button", { name: "Retry" }).click();
    expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
      threadId,
      operation: "title",
      sourceActivityId: status("failed").id,
    });
  });
  it("clears a durable warning after successful generation", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[status("failed"), status("completed")]}
      />,
    );
    expect(document.querySelector("[role=status]")).toBeNull();
  });
  it("does not hide a retry action after reconnecting with a pending request", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[status("failed"), status("retry-requested")]}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
