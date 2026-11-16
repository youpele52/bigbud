import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileConnectionNotice } from "./MobileConnectionNotice";
import {
  initialMobileConnectionState,
  type MobileConnectionState,
} from "../../logic/mobileConnection.logic";
import { initialMobileRecoveryState } from "../../logic/mobileRecovery.types";
import { MobileQueueNotice } from "../threads/thread/MobileQueueNotice";
import { MobileComposerDeliveryNotice } from "../threads/thread/composer/MobileComposerDeliveryNotice";

const state = initialMobileRecoveryState("refreshing");

function expectSmallBannerText(markup: string) {
  expect(markup).toContain("text-sm");
  expect(markup).not.toMatch(/\btext-(?:xs|base|lg|xl|[2-9]xl|\[\d)/);
}

describe("mobile status banners", () => {
  it.each(["disabled", "reconnecting", "rejected"] as const)(
    "keeps %s guidance usable without assuming the selected backend is a desktop",
    (scenario) => {
      const connection: MobileConnectionState = {
        ...initialMobileConnectionState(),
        transport: "closed",
        hostAccessOff: scenario === "disabled",
        incidentLevel: scenario === "reconnecting" ? "reconnecting" : "none",
        authorization: scenario === "rejected" ? "explicitly-rejected" : "unknown",
      };
      const markup = renderToStaticMarkup(
        <MobileConnectionNotice
          state={initialMobileRecoveryState("stale")}
          connection={connection}
          onRetry={vi.fn()}
        />,
      );
      expect(markup).not.toMatch(/\bdesktop\b|\blaptop\b/i);
      if (scenario === "disabled") {
        expect(markup).not.toContain("stays paired");
        expect(markup).toContain("fresh pairing link");
      }
      const status =
        scenario === "disabled" ? "warning" : scenario === "reconnecting" ? "loading" : "error";
      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain('role="status"');
      expect(markup.includes(">Retry<")).toBe(scenario === "disabled");
      expectSmallBannerText(markup);
    },
  );

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

  it("offers Send again only once a check found no record of the message", () => {
    const unchecked = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="uncertain"
        storageWarning={null}
        onCheckDelivery={vi.fn()}
      />,
    );
    expect(unchecked).not.toContain("Send again");
    const unknown = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="uncertain"
        storageWarning={null}
        onCheckDelivery={vi.fn()}
        onResendDelivery={vi.fn()}
      />,
    );
    expect(unknown).toContain("Send again");
    expect(unknown).toContain("no record of this message");
    expectSmallBannerText(unknown);
  });

  it("shows an uncertain approval/answer/interrupt with its own check and resend", () => {
    const pending = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="idle"
        storageWarning={null}
        decision={{ status: "uncertain", onCheck: vi.fn(), onResend: undefined }}
      />,
    );
    expect(pending).toContain("Check response");
    expect(pending).not.toContain("Send response again");
    expect(pending).toContain("border-l-warning");
    const unknown = renderToStaticMarkup(
      <MobileComposerDeliveryNotice
        deliveryState="idle"
        storageWarning={null}
        decision={{ status: "uncertain", onCheck: vi.fn(), onResend: vi.fn() }}
      />,
    );
    expect(unknown).toContain("Send response again");
    expect(unknown).toContain("no record of your response");
    expectSmallBannerText(unknown);
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
