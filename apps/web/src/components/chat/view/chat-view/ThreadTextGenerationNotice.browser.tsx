import "../../../../index.css";
import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { ThreadTextGenerationNotice } from "./ThreadTextGenerationNotice";
import { useThreadNoticeDismissalStore } from "../../../../stores/ui/threadNoticeDismissal.store";
import { useTextGenerationWarnings } from "../../../../stores/ui/textGenerationWarnings.store";

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
  payload: { operation: "title", finalFailure: true },
  turnId: null,
  createdAt: "2026-10-16T00:00:00.000Z",
});
function proof(count = 3): OrchestrationThreadActivity[] {
  return Array.from({ length: count }, (_, index) => {
    const turnId = TurnId.makeUnsafe(`turn-${index}`);
    return [
      {
        ...status("failed"),
        id: EventId.makeUnsafe(`bound-${index}`),
        kind: "text-generation.user-turn-bound",
        turnId,
        payload: { messageId: `user-${index}` },
      },
      {
        ...status("failed"),
        id: EventId.makeUnsafe(`success-${index}`),
        kind: "text-generation.model-succeeded",
        turnId,
        payload: { provider: "codex", model: "verified-model" },
      },
    ];
  }).flat();
}

describe("thread generation warning", () => {
  it("shows unconfirmed native work truthfully without offering a paid Retry action", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[
          {
            ...status("failed"),
            kind: "text-generation.uncertain",
            tone: "info",
            summary: "Native generation is unconfirmed. Automatic retries are paused.",
            payload: { operation: "title", uncertaintyId: "ses_retained" },
          },
        ]}
      />,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Automatic retries are paused");
    await expect
      .element(page.getByRole("button", { name: "Retry", exact: true }))
      .not.toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
  });
  it("does not resurrect a completed warning for a coalesced late retry request", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[status("failed"), status("completed"), status("retry-requested")]}
      />,
    );
    expect(document.querySelector("[role=status]")).toBeNull();
  });
  afterEach(async () => {
    // Unmount subscriptions before resetting session ownership, or old roots can reclaim a warning.
    await cleanup();
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    useTextGenerationWarnings.setState({ owners: new Map() });
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });
  it("dismisses across navigation and never resurfaces a new failure in this renderer session", async () => {
    const activity = status("failed");
    const first = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={[...proof(), activity]} />,
    );
    await page.getByRole("button", { name: "Dismiss thread title generation notice" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(activity.kind).toBe("text-generation.failed");
    await first.unmount();
    const reopened = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={[...proof(), activity]} />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await reopened.rerender(
      <ThreadTextGenerationNotice
        threadId={ThreadId.makeUnsafe("another-thread")}
        activities={[...proof(), activity]}
      />,
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    await reopened.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), { ...activity, id: EventId.makeUnsafe("another-failure") }]}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
  it("shows a nonblocking warning with a metadata-only Retry action", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed")]}
      />,
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
  it("dismisses title and summary independently while preserving the other metadata retry", async () => {
    const summary: OrchestrationThreadActivity = {
      ...status("failed"),
      id: EventId.makeUnsafe("summary-failure"),
      summary: "Couldn’t generate thread summary.",
      payload: { operation: "summary" },
    };
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed"), summary]}
      />,
    );
    await page.getByRole("button", { name: "Dismiss thread title generation notice" }).click();
    await expect.element(page.getByText(summary.summary)).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
      threadId,
      operation: "summary",
      sourceActivityId: summary.id,
    });
    await page.getByRole("button", { name: "Dismiss thread summary generation notice" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
  it("does not hide a retry action after reconnecting with a pending request", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed"), status("retry-requested")]}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
  it("waits for three distinct successful user turns and for final title fallback failure", async () => {
    const summary = {
      ...status("failed"),
      id: EventId.makeUnsafe("summary-failure"),
      payload: { operation: "summary" },
    };
    const view = await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(2), status("failed"), summary]}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    expect(useTextGenerationWarnings.getState().owners.size).toBe(0);
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), { ...status("failed"), payload: { operation: "title" } }, summary]}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Dismiss thread summary generation notice" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Dismiss thread title generation notice" }))
      .not.toBeInTheDocument();
  });
  it("does not remount even an undismissed warning, but a new app session can display it", async () => {
    const activities = [...proof(), status("failed")];
    const first = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={activities} />,
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    await first.unmount();
    const second = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={activities} />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    useTextGenerationWarnings.setState({ owners: new Map() });
    await expect.element(page.getByRole("status")).toBeVisible();
    await second.unmount();
  });
  it("does not redisplay an undismissed warning when the same view navigates away and back", async () => {
    const activities = [...proof(), status("failed")];
    const view = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={activities} />,
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={ThreadId.makeUnsafe("other-thread")}
        activities={activities}
      />,
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    await view.rerender(<ThreadTextGenerationNotice threadId={threadId} activities={activities} />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});
