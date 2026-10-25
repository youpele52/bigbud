import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";

const mockSettings = vi.hoisted(() => ({ contextWindowWarningThresholdTokens: 120_000 }));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => mockSettings,
}));

import { ContextWindowWarningBanner } from "./ContextWindowWarningBanner";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";

const BASE_USAGE = {
  usedTokens: 160_000,
  maxTokens: 200_000,
  usedPercentage: 80,
  remainingTokens: 40_000,
  remainingPercentage: 20,
  totalProcessedTokens: null,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: false,
  updatedAt: "2026-07-29T00:00:00Z",
} satisfies ContextWindowSnapshot;

function makeBanner(usage: ContextWindowSnapshot) {
  return (
    <ContextWindowWarningBanner
      threadId="thread-1"
      usage={usage}
      handoffAvailable
      onUseHandoff={vi.fn()}
    />
  );
}

describe("ContextWindowWarningBanner", () => {
  afterEach(() => {
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    document.body.innerHTML = "";
  });
  it("keeps dismissal across navigation, scopes it to the thread even after context drops", async () => {
    const first = await render(makeBanner(BASE_USAGE));
    await page.getByLabelText("Dismiss").click();
    await first.unmount();
    const reopened = await render(makeBanner(BASE_USAGE));
    await expect.element(page.getByText("Context window warning")).not.toBeInTheDocument();
    await reopened.rerender(
      <ContextWindowWarningBanner
        threadId="thread-other"
        usage={BASE_USAGE}
        handoffAvailable
        onUseHandoff={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Context window warning")).toBeVisible();
    await reopened.rerender(makeBanner({ ...BASE_USAGE, usedTokens: 100_000 }));
    await reopened.rerender(makeBanner(BASE_USAGE));
    await expect.element(page.getByText("Context window warning")).not.toBeInTheDocument();
  });

  it("stays dismissed when usage increases beyond the old rearm point", async () => {
    const screen = await render(makeBanner(BASE_USAGE));

    await page.getByLabelText("Dismiss").click();
    await expect.element(page.getByText("Context window warning")).not.toBeInTheDocument();

    await screen.rerender(makeBanner({ ...BASE_USAGE, usedTokens: 189_999 }));
    await expect.element(page.getByText("Context window warning")).not.toBeInTheDocument();

    await screen.rerender(makeBanner({ ...BASE_USAGE, usedTokens: 190_000 }));
    await expect.element(page.getByText("Context window warning")).not.toBeInTheDocument();
  });
});
