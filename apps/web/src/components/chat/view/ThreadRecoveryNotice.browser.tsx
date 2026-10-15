import "../../../index.css";

import type { MessageId, OrchestrationThreadActivity } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import { ThreadRecoveryNotice } from "./ThreadRecoveryNotice";

const pending = (requestedAt: string): ThreadTurnStartRequest => ({
  messageId: "user-1" as MessageId,
  requestedAt,
  outcome: "pending",
  settledAt: null,
});

describe("ThreadRecoveryNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("appears as a polite blue status only after 5 s without a started turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
    await render(
      <ThreadRecoveryNotice
        thread={{ turnStartRequest: pending("2026-10-15T10:00:00.000Z"), activities: [] }}
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

  it("offers continuing in a new thread after a failure in-place recovery cannot fix", async () => {
    const requestedAt = new Date(Date.now() - 1_000).toISOString();
    const onContinue = vi.fn();
    await render(
      <ThreadRecoveryNotice
        thread={{
          turnStartRequest: {
            ...pending(requestedAt),
            outcome: "failed",
            settledAt: new Date().toISOString(),
          },
          activities: [
            {
              id: "failure-1",
              tone: "error",
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              payload: { failureClass: "session-dead" },
              turnId: null,
              createdAt: new Date(Date.now() - 500).toISOString(),
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
    const requestedAt = new Date(Date.now() - 2_000).toISOString();
    const activity = (outcome: string) =>
      ({
        id: `activity-${outcome}`,
        tone: "info",
        kind: "provider.session.recovery",
        summary: "Recovery",
        payload: { step: "fresh-replay", outcome },
        turnId: null,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
      }) as unknown as OrchestrationThreadActivity;
    await render(
      <ThreadRecoveryNotice
        thread={{
          turnStartRequest: {
            ...pending(requestedAt),
            outcome: "started",
            settledAt: new Date().toISOString(),
          },
          activities: [activity("started"), activity("succeeded")],
        }}
      />,
    );
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("data-recovery-notice", "degraded");
    await expect.element(page.getByText("Continued in a fresh session")).toBeVisible();
  });
});
