import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StatusBanner } from "../common/StatusBanner";
import { ChatBanner } from "../chat/common/ChatBanner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";
import type { StatusSurfaceTone } from "./statusSurface";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

const tones: StatusSurfaceTone[] = ["default", "info", "loading", "success", "warning", "error"];

function expectNotificationSize(surface: Element) {
  for (const element of [surface, ...surface.querySelectorAll("*")]) {
    expect(getComputedStyle(element).fontSize, element.outerHTML).toBe("14px");
  }
}

afterEach(async () => {
  toastManager.close();
  await page.viewport(1280, 900);
});

it.each([390, 1280])(
  "keeps every banner's nested text and actions at 14px (width=%s)",
  async (width) => {
    await page.viewport(width, 900);
    const screen = await render(
      <div>
        {tones.map((variant) => (
          <StatusBanner
            key={variant}
            variant={variant}
            className="text-xs sm:text-lg"
            title={<span className="text-xs">{variant} title</span>}
            description={
              <span className="text-xs sm:text-base">
                Details <strong>with emphasis</strong> and <code className="text-[11px]">code</code>
              </span>
            }
            action={<Button size="xs">Retry</Button>}
            onDismiss={() => {}}
          />
        ))}
        <ChatBanner
          title="Chat notice"
          description="Chat details"
          action={<Button size="xs">Review</Button>}
          onDismiss={() => {}}
        />
        <Alert className="text-xs">
          <AlertTitle>Direct alert</AlertTitle>
          <AlertDescription className="text-xs">
            <details open>
              <summary className="text-xs">Manual guidance</summary>
              <code className="text-[11px]">diagnostic details</code>
            </details>
          </AlertDescription>
          <AlertAction>
            <Button size="xs">Check</Button>
          </AlertAction>
        </Alert>
        <Button size="xs" data-testid="ordinary-button">
          Outside notification
        </Button>
      </div>,
    );
    try {
      const alerts = document.querySelectorAll('[data-slot="alert"]');
      expect(alerts).toHaveLength(8);
      for (const alert of alerts) {
        expectNotificationSize(alert);
        expect(getComputedStyle(alert.querySelector('[data-slot="alert-title"]')!).fontWeight).toBe(
          "500",
        );
      }
      expect(getComputedStyle(document.querySelector("strong")!).fontWeight).toBe("700");
      const ordinaryButton = document.querySelector('[data-testid="ordinary-button"]')!;
      expect(getComputedStyle(ordinaryButton).fontSize).toBe(width < 640 ? "14px" : "12px");
    } finally {
      await screen.unmount();
    }
  },
);

it.each([390, 1280])(
  "keeps both toast APIs at 14px for every severity (width=%s)",
  async (width) => {
    await page.viewport(width, 900);
    const screen = await render(
      <ToastProvider>
        <AnchoredToastProvider />
      </ToastProvider>,
    );
    try {
      for (const [api, manager] of [
        ["standard", toastManager],
        ["anchored", anchoredToastManager],
      ] as const) {
        for (const type of tones) {
          const title = `${api} ${type} toast`;
          const id = manager.add({
            title: <span className="text-xs sm:text-lg">{title}</span>,
            description: <span className="text-[11px]">Toast details</span>,
            type,
            timeout: 0,
            actionProps: { children: "View", onClick: vi.fn() },
          });
          await expect.element(screen.getByText(title)).toBeVisible();
          const toast = document.querySelector(
            '[data-slot="toast-popup"]:not([data-ending-style])',
          )!;
          expectNotificationSize(toast);
          expect(
            getComputedStyle(toast.querySelector('[data-slot="toast-title"]')!).fontWeight,
          ).toBe("500");
          expect(
            getComputedStyle(toast.querySelector('[data-slot="toast-description"]')!).fontWeight,
          ).toBe("400");
          expect(
            getComputedStyle(toast.querySelector('[data-slot="toast-action"]')!).fontWeight,
          ).toBe("500");
          manager.close(id);
          await expect.element(screen.getByText(title)).not.toBeInTheDocument();
        }
      }
    } finally {
      toastManager.close();
      await screen.unmount();
    }
  },
);
