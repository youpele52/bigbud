import "../../../index.css";

import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), toast: vi.fn() }));
vi.mock("../../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatch } }),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { ThreadModelChoiceNotice } from "./ThreadModelChoiceNotice";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import {
  makeRequestedPayload,
  makeResolvedPayload,
  modelChoiceActivity,
  TRUNK_SELECTION,
} from "./ThreadModelChoiceNotice.test.helpers";

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: unknown) => resolve(value) };
}

const renderNotice = (id: string, activities: OrchestrationThreadActivity[]) =>
  render(<ThreadModelChoiceNotice thread={{ id: id as ThreadId, activities }} />);

describe("ThreadModelChoiceNotice", () => {
  beforeEach(() => {
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    vi.clearAllMocks();
    mocks.dispatch.mockResolvedValue({ sequence: 1 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await page.viewport(1280, 800);
    document.body.innerHTML = "";
  });

  it("is a polite blue status that counts down on this browser's clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    await renderNotice("thread-countdown", [
      modelChoiceActivity(
        "requested",
        makeRequestedPayload({ choiceId: "choice-countdown" }),
        // An hour-old server timestamp does not shorten the browser's countdown.
        "2026-10-15T11:00:00.000Z",
      ),
    ]);
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("aria-live", "polite");
    await expect.element(status).toHaveAttribute("data-model-choice-notice", "pending");
    await expect.element(page.getByText("Choose a model for this thread")).toBeVisible();
    await expect.element(page.getByText(/using gpt-5 in 10s/)).toBeVisible();

    // One tick per second: each render schedules the next tick.
    for (let seconds = 9; seconds >= 1; seconds -= 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(document.body.textContent).toContain(`in ${seconds}s`));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Using gpt-5 now…"));
  });

  it("offers the first 12 options, then all, and disables them while a pick is in flight", async () => {
    const inFlight = deferred();
    mocks.dispatch.mockImplementation(() => inFlight.promise);
    await renderNotice("thread-pick", [
      modelChoiceActivity(
        "requested",
        makeRequestedPayload({ choiceId: "choice-pick", extra: 14 }),
      ),
    ]);
    const group = page.getByRole("group", { name: "Available models" });
    await expect.element(page.getByRole("button", { name: /Show all \(4 more\)/ })).toBeVisible();
    expect(group.getByRole("button").elements()).toHaveLength(13);
    await page.getByRole("button", { name: /Show all/ }).click();
    expect(group.getByRole("button").elements()).toHaveLength(16);

    await page.getByRole("button", { name: /Claude Sonnet/ }).click();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.delegation.model-choice.pick",
        threadId: "thread-pick",
        choiceId: "choice-pick",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
      }),
    );
    await expect.element(page.getByRole("button", { name: "Use GPT-5 now" })).toBeDisabled();
    inFlight.resolve({ sequence: 2 });
    await expect.element(page.getByRole("button", { name: "Use GPT-5 now" })).toBeEnabled();

    await page.getByRole("button", { name: "Use GPT-5 now" }).click();
    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelSelection: TRUNK_SELECTION }),
    );
  });

  it("shows green and amber outcomes as persistent lines", async () => {
    const requested = modelChoiceActivity("requested", makeRequestedPayload());
    await renderNotice("thread-picked", [
      requested,
      modelChoiceActivity(
        "resolved",
        makeResolvedPayload({
          used: { provider: "claudeAgent", model: "claude-sonnet" },
          outcome: "user-picked",
          resolvedBy: "user",
        }),
      ),
    ]);
    await expect
      .element(page.getByRole("status"))
      .toHaveAttribute("data-model-choice-notice", "user-picked");
    await expect
      .element(page.getByText("You chose claude-sonnet (requested composer-1 unavailable)"))
      .toBeVisible();
    document.body.innerHTML = "";

    await renderNotice("thread-fallback", [
      requested,
      modelChoiceActivity("resolved", makeResolvedPayload()),
    ]);
    await expect
      .element(page.getByRole("status"))
      .toHaveAttribute("data-model-choice-notice", "fallback");
    await expect
      .element(page.getByText("Requested composer-1 unavailable (provider is hidden); used gpt-5"))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Dismiss model choice notice" }))
      .toBeVisible();
  });

  it("wraps the options on a phone-sized viewport without horizontal overflow", async () => {
    await page.viewport(375, 740);
    await renderNotice("thread-mobile", [
      modelChoiceActivity(
        "requested",
        makeRequestedPayload({ choiceId: "choice-mobile", extra: 8 }),
      ),
    ]);
    const picker = document.querySelector<HTMLElement>("[data-model-choice-picker]");
    expect(picker).not.toBeNull();
    expect(picker!.scrollWidth).toBeLessThanOrEqual(picker!.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it("renders nothing for a thread without a model choice", async () => {
    await renderNotice("thread-none", []);
    expect(page.getByRole("status").elements()).toHaveLength(0);
  });
  it("hides the picker without picking a model and keeps the resolved choice closed", async () => {
    const requested = modelChoiceActivity("requested", makeRequestedPayload());
    const first = await renderNotice("thread-dismiss", [requested]);
    await page.getByRole("button", { name: "Dismiss model choice notice" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await first.unmount();
    const reopened = await renderNotice("thread-dismiss", [requested]);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await reopened.rerender(
      <ThreadModelChoiceNotice
        thread={{
          id: "thread-dismiss" as ThreadId,
          activities: [requested, modelChoiceActivity("resolved", makeResolvedPayload())],
        }}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});
