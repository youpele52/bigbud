import "../../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ComposerPlanFollowUpBanner } from "../composer/ComposerPlanFollowUpBanner";
import { ChatBanner } from "./ChatBanner";
import { LegacyOpencodeNotice } from "./LegacyOpencodeNotice";
import { OpencodeV2RetainedHistoryNotice } from "./OpencodeV2RetainedHistoryNotice";
import { ThreadNoticeBanner } from "./ThreadNoticeBanner";

afterEach(async () => {
  document.body.innerHTML = "";
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  vi.restoreAllMocks();
  await page.viewport(1280, 800);
});

it("dismisses the setup warning by keyboard without changing the source condition", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const condition = Object.freeze({
    error: "V2 selected thread has no supported local native Location; no local/private fallback.",
    setupRevision: "revision-one",
  });
  const notice = (threadId = "setup-one", revision: string = condition.setupRevision) => (
    <ThreadNoticeBanner
      threadId={threadId}
      kind="opencode-setup"
      data-setup-revision={revision}
      title="OpenCode setup"
      description={condition.error}
      variant="warning"
      dismissLabel="Dismiss OpenCode setup notice"
    />
  );
  const first = await render(notice());
  (
    page
      .getByRole("button", { name: "Dismiss OpenCode setup notice" })
      .element() as HTMLButtonElement
  ).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(condition.error).toContain("no local/private fallback");
  expect(storage).toHaveBeenCalled();
  await first.unmount();
  const reopened = await render(notice());
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await reopened.rerender(notice("setup-two"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  await reopened.rerender(notice("setup-one", "revision-two"));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  await reopened.rerender(notice());
  await expect.element(page.getByRole("alert")).toBeVisible();
});

it("makes retained-history, legacy and plan notices closeable without changing their inputs", async () => {
  const screen = await render(
    <>
      <LegacyOpencodeNotice threadId="legacy-one" />
      <OpencodeV2RetainedHistoryNotice
        threadId="retained-one"
        message="Retained read-only history"
      />
      <ComposerPlanFollowUpBanner
        threadId="plan-thread"
        planId="plan-one"
        planTitle="Review the plan"
      />
    </>,
  );
  for (const label of [
    "Dismiss legacy OpenCode notice",
    "Dismiss retained history notice",
    "Dismiss plan ready notice",
  ]) {
    await page.getByRole("button", { name: label }).click();
  }
  expect(document.querySelectorAll("[data-chat-banner]")).toHaveLength(0);
  await screen.rerender(
    <OpencodeV2RetainedHistoryNotice
      threadId="retained-one"
      message="Changed retained history condition"
    />,
  );
  await expect
    .element(page.getByText("Changed retained history condition"))
    .not.toBeInTheDocument();
});

it.each([375, 1280])(
  "keeps common width, padding, typography and close placement at %ipx without fixed heights",
  async (width) => {
    await page.viewport(width, 900);
    const action = vi.fn();
    await render(
      <>
        <ChatBanner
          variant="error"
          title="Short"
          description="Short description"
          onDismiss={vi.fn()}
        />
        <ChatBanner
          variant="warning"
          title="Longer"
          description={"Long descriptive text. ".repeat(65)}
          onDismiss={vi.fn()}
          action={
            <button type="button" onClick={action}>
              Retry setup
            </button>
          }
        />
      </>,
    );
    const banners = [...document.querySelectorAll<HTMLElement>("[data-slot=alert]")];
    const short = banners[0]!;
    const long = banners[1]!;
    expect(short.getBoundingClientRect().width).toBe(long.getBoundingClientRect().width);
    expect(getComputedStyle(short).padding).toBe(getComputedStyle(long).padding);
    expect(getComputedStyle(short).fontSize).toBe("14px");
    expect(getComputedStyle(long).fontSize).toBe("14px");
    expect(long.getBoundingClientRect().height).toBeGreaterThan(
      short.getBoundingClientRect().height,
    );
    const offsets = banners.map((banner) => {
      const bounds = banner.getBoundingClientRect();
      const close = banner
        .querySelector<HTMLButtonElement>("button[aria-label=Dismiss]")!
        .getBoundingClientRect();
      return [bounds.right - close.right, close.top - bounds.top];
    });
    expect(offsets[0]).toEqual(offsets[1]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Retry setup" }).click();
    expect(action).toHaveBeenCalledOnce();
  },
);
