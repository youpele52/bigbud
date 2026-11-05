import "../../../../index.css";
import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { toastManager } from "../../../ui/toast";
import { useTextGenerationWarnings } from "../../../../stores/ui/textGenerationWarnings.store";
import { ThreadTextGenerationNotice } from "./ThreadTextGenerationNotice";

const mocks = vi.hoisted(() => ({ retry: vi.fn(() => Promise.resolve()) }));
vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => ({ server: { retryTextGeneration: mocks.retry } }),
}));
const threadId = ThreadId.makeUnsafe("thread-fixture");
const status = (
  kind: "failed" | "completed" | "retry-requested" | "uncertain",
  operation: "title" | "summary" = "title",
): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(`fixture:${operation}:${kind}`),
  kind: `text-generation.${kind}`,
  tone: "info",
  summary: `Couldn’t generate thread ${operation}. You can retry without resending your message.`,
  payload: { operation, finalFailure: true },
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

const add = vi.spyOn(toastManager, "add");
const close = vi.spyOn(toastManager, "close");

afterEach(async () => {
  await cleanup();
  toastManager.close();
  useTextGenerationWarnings.setState({ owners: new Map() });
  vi.clearAllMocks();
});

describe("thread generation notices", () => {
  it("does not notify for unconfirmed native work", async () => {
    await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={[status("uncertain")]} />,
    );
    expect(add).not.toHaveBeenCalled();
    expect(useTextGenerationWarnings.getState().owners.size).toBe(0);
  });

  it("shows a final title failure as a thread-scoped toast with metadata-only Retry", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed")]}
      />,
    );
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "warning",
        title: "Couldn’t generate thread title",
        data: { threadId },
        actionProps: expect.objectContaining({ children: "Retry" }),
      }),
    );
    const options = add.mock.calls[0]![0];
    options.actionProps?.onClick?.({} as never);
    await vi.waitFor(() => {
      expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
        threadId,
        operation: "title",
        sourceActivityId: status("failed").id,
      });
    });
  });

  it("does not show early title failures, but shows summary failures after eligibility", async () => {
    const view = await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(2), status("failed")]}
      />,
    );
    expect(add).not.toHaveBeenCalled();
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed", "summary")]}
      />,
    );
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Couldn’t generate thread summary" }),
    );
  });

  it("closes a warning after generation completes and never replays it on remount", async () => {
    const activities = [...proof(), status("failed")];
    const view = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={activities} />,
    );
    const toastId = add.mock.results[0]?.value;
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...activities, status("completed")]}
      />,
    );
    expect(close).toHaveBeenCalledWith(toastId);
    await view.unmount();
    await render(<ThreadTextGenerationNotice threadId={threadId} activities={activities} />);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("does not show another toast for a later failure in the same session", async () => {
    const activities = [...proof(), status("failed")];
    const view = await render(
      <ThreadTextGenerationNotice threadId={threadId} activities={activities} />,
    );
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...activities, status("completed")]}
      />,
    );
    await view.rerender(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[
          ...activities,
          status("completed"),
          { ...status("failed"), id: EventId.makeUnsafe("later-failure") },
        ]}
      />,
    );
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed warning cleared after a late coalesced retry request", async () => {
    await render(
      <ThreadTextGenerationNotice
        threadId={threadId}
        activities={[...proof(), status("failed"), status("completed"), status("retry-requested")]}
      />,
    );
    expect(add).not.toHaveBeenCalled();
  });
});
