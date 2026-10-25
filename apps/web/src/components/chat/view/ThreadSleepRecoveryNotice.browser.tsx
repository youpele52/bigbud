import "../../../index.css";

import type { MessageId, ThreadId } from "@bigbud/contracts";
import type { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), toast: vi.fn() }));
vi.mock("../../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatch } }),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ThreadSleepRecoveryNotice } from "./ThreadSleepRecoveryNotice";

let threadCounter = 0;
const nextThreadId = () => `sleep-thread-${(threadCounter += 1)}` as ThreadId;

const recovery = (overrides: Partial<ThreadRecovery>): ThreadRecovery => ({
  status: "awaiting-user",
  reason: "tool-in-flight",
  toolSummary: "npm test",
  attempt: 0,
  provider: "codex",
  messageId: "message-1" as MessageId,
  updatedAt: "2026-10-22T10:00:00.000Z",
  ...overrides,
});

const renderNotice = (value: ThreadRecovery | null, id = nextThreadId()) =>
  render(<ThreadSleepRecoveryNotice thread={{ id, recovery: value }} />);

function dispatched() {
  return mocks.dispatch.mock.calls.map(([command]) => command as Record<string, unknown>);
}

describe("ThreadSleepRecoveryNotice", () => {
  beforeEach(() => {
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    vi.clearAllMocks();
    mocks.dispatch.mockResolvedValue({ sequence: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("shows a blue 'Resuming after sleep…' only after 3 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    await renderNotice(recovery({ status: "continuing", reason: "interrupted-by-sleep" }));
    await expect.element(page.getByText("Resuming after sleep…")).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3_000);

    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("aria-live", "polite");
    await expect.element(status).toHaveAttribute("data-sleep-recovery-notice", "resuming");
    await expect.element(status).toHaveClass(/border-info/);
    await expect.element(page.getByText("Resuming after sleep…")).toBeVisible();
  });

  it("shows the provider-continued notice for 6 s only", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    await renderNotice(recovery({ status: "provider-continued", reason: "provider-continued" }));
    await expect.element(page.getByText("Codex continued on its own after sleep.")).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveClass(/border-info/);
    expect(page.getByRole("button", { name: "Continue" }).query()).toBeNull();

    await vi.advanceTimersByTimeAsync(6_000);
    await expect
      .element(page.getByText("Codex continued on its own after sleep."))
      .not.toBeInTheDocument();
  });

  it("names the in-flight tool in amber and sends Continue only when chosen", async () => {
    await renderNotice(recovery({}));
    const alert = page.getByRole("alert");
    await expect.element(alert).toHaveClass(/border-warning/);
    await expect
      .element(
        page.getByText(
          "The computer slept while npm test was running. Its outcome is unknown. Check before continuing.",
        ),
      )
      .toBeVisible();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() =>
      expect(dispatched()).toEqual([
        expect.objectContaining({
          type: "thread.recovery.resolve",
          action: "continue",
          messageId: "message-1",
        }),
      ]),
    );
  });

  it("dismisses the tool prompt on the server with Dismiss", async () => {
    await renderNotice(recovery({}));
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "dismiss" }));
  });

  it("offers Keep waiting and Stop and continue, reachable by keyboard", async () => {
    await renderNotice(recovery({ reason: "no-activity-after-wake", toolSummary: null }));
    await expect.element(page.getByText("No activity since wake.")).toBeVisible();

    const keepWaiting = page.getByRole("button", { name: "Keep waiting" });
    (keepWaiting.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "keep-waiting" }));

    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByRole("button", { name: "Stop and continue" })).toHaveFocus();
    await userEvent.keyboard(" ");
    await vi.waitFor(() => expect(dispatched()[1]).toMatchObject({ action: "stop-and-continue" }));
  });

  it("asks after a post-wake backend restart", async () => {
    await renderNotice(recovery({ reason: "backend-restarted-after-wake", toolSummary: null }));
    await expect
      .element(page.getByText("bigbud restarted after wake. This turn's outcome is unknown."))
      .toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "continue" }));
  });

  it("says a cut response was interrupted, in amber, with Continue and Dismiss", async () => {
    await renderNotice(recovery({ reason: "interrupted-by-sleep", toolSummary: null }));
    await expect.element(page.getByRole("alert")).toHaveClass(/border-warning/);
    await expect
      .element(page.getByText("The response was interrupted when the computer went to sleep."))
      .toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "continue" }));
  });

  it("reports a failed Continue in red", async () => {
    await renderNotice(recovery({ reason: "continuation-failed", toolSummary: null }));
    await expect.element(page.getByRole("alert")).toHaveClass(/destructive|error/);
    await expect.element(page.getByText("Couldn't resume after sleep.")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "dismiss" }));
  });

  it("parks in red with Retry", async () => {
    await renderNotice(recovery({ status: "parked", reason: "continuation-failed", attempt: 3 }));
    await expect.element(page.getByRole("alert")).toHaveClass(/destructive|error/);
    await expect.element(page.getByText("Couldn't resume after 3 tries.")).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() => expect(dispatched()[0]).toMatchObject({ action: "retry" }));
  });

  it("disables every action while one is in flight and reports a failure in red", async () => {
    let reject!: (error: Error) => void;
    mocks.dispatch.mockImplementation(
      () => new Promise((_, fail) => (reject = fail as (error: Error) => void)),
    );
    await renderNotice(recovery({}));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Dismiss", exact: true })).toBeDisabled();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    reject(new Error("offline"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "offline" }),
      ),
    );
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("keeps a closed notice hidden for this state and shows a newer state again", async () => {
    const id = nextThreadId();
    const screen = await renderNotice(recovery({}), id);
    await page.getByRole("button", { name: "Dismiss sleep recovery notice" }).click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await screen.unmount();
    const reopened = await renderNotice(recovery({ updatedAt: "2026-10-22T10:05:00.000Z" }), id);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await reopened.rerender(
      <ThreadSleepRecoveryNotice
        thread={{ id, recovery: recovery({ status: "parked", reason: "continuation-failed" }) }}
      />,
    );
    await expect.element(page.getByText(/Couldn't resume after/)).toBeVisible();
  });

  it("hides each new try for 3 s and shows a later failure after an earlier one was closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    const id = nextThreadId();
    const tryNumber = (attempt: number, status: ThreadRecovery["status"]) =>
      recovery({ status, reason: "continuation-failed", toolSummary: null, attempt });
    const screen = await renderNotice(tryNumber(2, "continuing"), id);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect.element(page.getByText("Resuming after sleep…")).toBeVisible();

    await screen.rerender(
      <ThreadSleepRecoveryNotice thread={{ id, recovery: tryNumber(3, "continuing") }} />,
    );
    await expect.element(page.getByText("Resuming after sleep…")).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect.element(page.getByText("Resuming after sleep…")).toBeVisible();

    await screen.rerender(
      <ThreadSleepRecoveryNotice thread={{ id, recovery: tryNumber(3, "awaiting-user") }} />,
    );
    await page.getByRole("button", { name: "Dismiss sleep recovery notice" }).click();
    await expect.element(page.getByText("Couldn't resume after sleep.")).not.toBeInTheDocument();
    await screen.rerender(
      <ThreadSleepRecoveryNotice thread={{ id, recovery: tryNumber(4, "awaiting-user") }} />,
    );
    await expect.element(page.getByText("Couldn't resume after sleep.")).toBeVisible();
  });

  it("dismisses the post-wake restart prompt on the server with Dismiss", async () => {
    await renderNotice(recovery({ reason: "backend-restarted-after-wake", toolSummary: null }));
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await vi.waitFor(() =>
      expect(dispatched()).toEqual([
        expect.objectContaining({
          type: "thread.recovery.resolve",
          action: "dismiss",
          messageId: "message-1",
        }),
      ]),
    );
  });

  it("sends Continue from a failed continuation", async () => {
    await renderNotice(recovery({ reason: "continuation-failed", toolSummary: null }));
    await page.getByRole("button", { name: "Continue" }).click();
    await vi.waitFor(() =>
      expect(dispatched()).toEqual([
        expect.objectContaining({ action: "continue", messageId: "message-1" }),
      ]),
    );
  });

  it("removes the banner when the thread's recovery becomes null", async () => {
    const id = nextThreadId();
    const screen = await renderNotice(recovery({}), id);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await screen.rerender(<ThreadSleepRecoveryNotice thread={{ id, recovery: null }} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector("[data-sleep-recovery-notice]")).toBeNull();
  });

  it("closes the notice with the keyboard, without a server action", async () => {
    await renderNotice(recovery({}));
    const close = page.getByRole("button", { name: "Dismiss sleep recovery notice" });
    (close.element() as HTMLButtonElement).focus();
    await expect.element(close).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("renders nothing without a recovery state", async () => {
    await renderNotice(null);
    await renderNotice(recovery({ status: "continued" }));
    expect(document.querySelector("[data-sleep-recovery-notice]")).toBeNull();
  });
});
