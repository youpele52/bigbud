import "../../../index.css";

import {
  EventId,
  type MessageId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ChatMessage, ThreadTurnStartRequest } from "../../../models/types/app.types";
import { ThreadRecoveryNotice } from "./ThreadRecoveryNotice";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";

const pending = (requestedAt: string): ThreadTurnStartRequest => ({
  messageId: "user-1" as MessageId,
  requestedAt,
  outcome: "pending",
  settledAt: null,
  recoverySteps: [],
});

describe("ThreadRecoveryNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  });

  it("appears as a polite blue status only after 5 s without a started turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
    await render(
      <ThreadRecoveryNotice
        thread={{
          id: "thread-wait" as ThreadId,
          // The request's command clock is an hour behind; the wait uses the browser clock only.
          turnStartRequest: pending("2026-10-15T09:00:00.000Z"),
          messages: [],
          activities: [],
        }}
      />,
    );
    await expect.element(page.getByText("Reconnecting…")).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5_000);

    const status = page.getByRole("status");
    await expect.element(status).toBeVisible();
    await expect.element(status).toHaveAttribute("aria-live", "polite");
    await expect.element(status).toHaveAttribute("data-recovery-notice", "reconnecting");
    await expect.element(page.getByText("Reconnecting…")).toBeVisible();
  });

  it("offers continuing in a new thread from server state alone (after a reload)", async () => {
    const createdAt = "2026-10-15T10:00:00.000Z";
    const message: ChatMessage = {
      id: "user-1" as MessageId,
      role: "user",
      text: "hello",
      turnId: null,
      createdAt,
      streaming: false,
    };
    const onContinue = vi.fn();
    await render(
      <ThreadRecoveryNotice
        thread={{
          id: "thread-reload" as ThreadId,
          turnStartRequest: undefined,
          messages: [message],
          activities: [
            {
              id: "failure-1",
              tone: "error",
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              payload: { failureClass: "session-dead" },
              turnId: null,
              createdAt,
            } as unknown as OrchestrationThreadActivity,
          ],
        }}
        onContinueInNewThread={onContinue}
      />,
    );
    await expect.element(page.getByText("Could not reconnect")).toBeVisible();
    await page.getByRole("button", { name: "Continue in a new thread" }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("shows the amber fresh-session outcome after a recovered start", async () => {
    await render(
      <ThreadRecoveryNotice
        thread={{
          id: "thread-amber" as ThreadId,
          turnStartRequest: {
            ...pending("2026-10-15T10:00:00.000Z"),
            outcome: "started",
            settledAt: "2026-10-15T10:00:02.000Z",
            recoverySteps: [
              { step: "fresh-replay", outcome: "started" },
              { step: "fresh-replay", outcome: "succeeded" },
            ],
          },
          messages: [],
          activities: [],
        }}
      />,
    );
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("data-recovery-notice", "degraded");
    await expect.element(page.getByText("Continued in a fresh session")).toBeVisible();
  });

  it("remembers closing a failure across navigation, scopes it to the thread, and ignores new failure revisions", async () => {
    const thread = {
      id: "dismiss-recovery" as ThreadId,
      messages: [
        { id: "pending", role: "user", createdAt: "2026-10-15T10:00:00.000Z", turnId: null },
      ] as ChatMessage[],
      activities: [
        {
          id: "failure-close",
          kind: "provider.turn.start.failed",
          tone: "error",
          summary: "Failed",
          payload: { failureClass: "session-dead" },
          turnId: null,
          createdAt: "2026-10-15T10:00:00.000Z",
        },
      ] as OrchestrationThreadActivity[],
    };
    const before = structuredClone(thread);
    const onContinue = vi.fn();
    const screen = await render(
      <ThreadRecoveryNotice thread={thread} onContinueInNewThread={onContinue} />,
    );
    await page.getByRole("button", { name: "Dismiss recovery notice" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    expect(thread).toEqual(before);
    expect(deriveServerTurnFailure(thread)?.failureClass).toBe("session-dead");
    expect(onContinue).not.toHaveBeenCalled();
    await screen.unmount();
    const reopened = await render(<ThreadRecoveryNotice thread={thread} />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await reopened.rerender(
      <ThreadRecoveryNotice thread={{ ...thread, id: "other-thread" as ThreadId }} />,
    );
    await expect.element(page.getByText("Could not reconnect")).toBeVisible();
    await reopened.rerender(
      <ThreadRecoveryNotice
        thread={{
          ...thread,
          activities: [{ ...thread.activities[0]!, id: EventId.makeUnsafe("new-failure") }],
        }}
      />,
    );
    await expect.element(page.getByText("Could not reconnect")).not.toBeInTheDocument();
  });
});
