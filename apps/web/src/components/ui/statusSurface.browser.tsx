import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StatusBanner } from "../common/StatusBanner";
import { ToastProvider, toastManager } from "./toast";
import type { StatusSurfaceTone } from "./statusSurface";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

afterEach(() => {
  toastManager.close();
  document.documentElement.classList.remove("dark");
});

const tones: StatusSurfaceTone[] = ["default", "info", "loading", "success", "warning", "error"];

function luminance(color: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it.each([false, true])(
  "shares visible rails, aligned text and progress-only icons (dark=%s)",
  async (dark) => {
    document.documentElement.classList.toggle("dark", dark);
    const screen = await render(<ToastProvider />);
    for (const tone of tones) {
      const banner = await render(
        <div style={{ width: 280 }}>
          <StatusBanner
            variant={tone}
            title={`${tone} banner`}
            description="Detailed status message"
            onDismiss={vi.fn()}
          />
        </div>,
      );
      const id = toastManager.add({
        title: `${tone} toast`,
        description: "Detailed status message",
        type: tone,
        timeout: 0,
      });
      await expect.element(screen.getByText(`${tone} toast`)).toBeVisible();
      const alert = document.querySelector<HTMLElement>('[data-slot="alert"]')!;
      const toast = document.querySelector<HTMLElement>(
        '[data-slot="toast-popup"]:not([data-ending-style])',
      )!;
      const alertStyle = getComputedStyle(alert);
      expect(alertStyle.borderLeftWidth).toBe("2px");
      expect(getComputedStyle(toast).borderLeftWidth).toBe("2px");
      expect(getComputedStyle(toast).borderLeftColor).toBe(alertStyle.borderLeftColor);
      expect(alertStyle.borderLeftColor).not.toBe(alertStyle.borderRightColor);
      if (tone === "default" || tone === "info") {
        const rail = luminance(alertStyle.borderLeftColor);
        const background = luminance(getComputedStyle(document.body).backgroundColor);
        expect(
          (Math.max(rail, background) + 0.05) / (Math.min(rail, background) + 0.05),
        ).toBeGreaterThanOrEqual(3);
      }
      for (const [surface, prefix] of [
        [alert, "alert"],
        [toast, "toast"],
      ] as const) {
        const title = surface.querySelector(`[data-slot="${prefix}-title"]`)!;
        const description = surface.querySelector(`[data-slot="${prefix}-description"]`)!;
        expect(title.getBoundingClientRect().left).toBe(description.getBoundingClientRect().left);
        expect(surface.querySelectorAll(".animate-spin")).toHaveLength(tone === "loading" ? 1 : 0);
        // All other icons are functional close controls, not severity symbols.
        for (const icon of surface.querySelectorAll("svg:not(.animate-spin)")) {
          expect(icon.closest("button")).not.toBeNull();
        }
        expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
      }
      toastManager.close(id);
      await expect.element(screen.getByText(`${tone} toast`)).not.toBeInTheDocument();
      await banner.unmount();
    }
    await screen.unmount();
  },
);
