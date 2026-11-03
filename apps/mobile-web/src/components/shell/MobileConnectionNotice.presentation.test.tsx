import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileConnectionNotice } from "./MobileConnectionNotice";
import { initialMobileRecoveryState } from "../../logic/mobileRecovery.types";
import { MobileQueueNotice } from "../threads/thread/MobileQueueNotice";
import { MobileComposerDeliveryNotice } from "../threads/thread/composer/MobileComposerDeliveryNotice";

const state = initialMobileRecoveryState("refreshing");

function expectSmallBannerText(markup: string) {
  expect(markup).toContain("text-sm");
  expect(markup).not.toMatch(/\btext-(?:xs|base|lg|xl|[2-9]xl|\[\d)/);
}

describe("mobile status banners", () => {
  it("shares blue progress and aligned title/description slots with the main app", () => {
    const markup = renderToStaticMarkup(<MobileConnectionNotice state={state} />);
    expect(markup).toContain('data-status="loading"');
    expect(markup).toContain("border-l-info-foreground");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain('data-slot="alert-title"');
    expect(markup).toContain('data-slot="alert-description"');
    expectSmallBannerText(markup);
  });

  it.each(["stale", "legacy"] as const)(
    "keeps %s refresh evidence and retry actions at 14px",
    (freshness) => {
      const markup = renderToStaticMarkup(
        <MobileConnectionNotice state={initialMobileRecoveryState(freshness)} onRetry={vi.fn()} />,
      );
      expectSmallBannerText(markup);
      expect(markup).toContain("No successful refresh yet.");
      expect(markup).toContain("Retry");
      expect(markup).toContain("font-medium");
      expect(markup).toContain("text-muted-foreground/70");
    },
  );

  it("keeps queued information neutral and preserves its count", () => {
    const markup = renderToStaticMarkup(<MobileQueueNotice queuedPromptCount={2} />);
    expect(markup).toContain("border-l-muted-foreground");
    expect(markup).toContain("Queued 2/5");
    expect(markup).not.toContain("<svg");
    expectSmallBannerText(markup);
  });

  it("keeps uncertain delivery amber with its action, and checking blue with a spinner", () => {
    const uncertain = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="uncertain"
        storageWarning={null}
        onCheckDelivery={vi.fn()}
      />,
    );
    expect(uncertain).toContain("border-l-warning");
    expect(uncertain).toContain("Check delivery");
    expect(uncertain).not.toContain("<svg");
    expectSmallBannerText(uncertain);
    const checking = renderToStaticMarkup(
      <MobileComposerDeliveryNotice deliveryState="reconciling" storageWarning={null} />,
    );
    expect(checking).toContain("border-l-info-foreground");
    expect(checking).toContain("animate-spin");
    expectSmallBannerText(checking);
  });

  it("keeps storage warning text at 14px without changing its severity", () => {
    const markup = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="idle"
        storageWarning="Draft could not be saved on this device."
      />,
    );
    expectSmallBannerText(markup);
    expect(markup).toContain('data-status="warning"');
    expect(markup).toContain("Draft could not be saved on this device.");
  });
});
